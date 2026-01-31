export interface StarvellProfile {
  available?: number;
  pending?: number;
  frozen?: number;
  raw?: any;
}

export interface StarvellOfferInfo {
  offerId?: string;
  pricePerUnit?: number;
  minQty?: number;
  raw?: any;
}

export class StarvellReadClient {
  private readonly cookie: string;
  private readonly logger?: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void };

  constructor(cookie: string, logger?: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void }) {
    this.cookie = normalizeCookie(cookie);
    this.logger = logger;
  }

  isEnabled() {
    return Boolean(this.cookie);
  }

  async getProfile(): Promise<StarvellProfile> {
    try {
      return await this.getProfileApi();
    } catch {
      return await this.getProfileHtml();
    }
  }

  async getProfileApi(): Promise<StarvellProfile> {
    if (!this.cookie) {
      throw new Error("STARVELL_COOKIE missing");
    }
    const endpoints = [
      "https://starvell.com/api/users/profile",
      "https://starvell.com/api/profile",
      "https://starvell.com/api/account/profile",
    ];
    for (const url of endpoints) {
      try {
        const started = Date.now();
        const resp = await fetch(url, {
          headers: {
            cookie: this.cookie,
            "user-agent": "Mozilla/5.0",
            accept: "application/json",
            "cache-control": "no-cache",
          },
        });
        const elapsed = Date.now() - started;
        this.logger?.info?.({ url, status: resp.status, elapsedMs: elapsed }, "STARVELL_BALANCE_HTTP");
        if (!resp.ok) continue;
        const data = await resp.json();
        const profile = extractProfile(data, this.logger);
        if (profile) return { ...profile, raw: data };
      } catch (err) {
        this.logger?.warn?.({ err, url }, "STARVELL_BALANCE_HTTP_ERROR");
      }
    }
    throw new Error("STARVELL_PROFILE_API_UNAVAILABLE");
  }

  async getProfileHtml(): Promise<StarvellProfile> {
    if (!this.cookie) {
      throw new Error("STARVELL_COOKIE missing");
    }
    const pages = [
      "https://starvell.com/wallet",
      "https://starvell.com/account",
      "https://starvell.com/account/sells",
      "https://starvell.com/profile",
    ];
    for (const page of pages) {
      try {
        const started = Date.now();
        const resp = await fetch(page, {
          headers: {
            cookie: this.cookie,
            "user-agent": "Mozilla/5.0",
            accept: "text/html",
            "cache-control": "no-cache",
          },
        });
        const elapsed = Date.now() - started;
        this.logger?.info?.({ url: page, status: resp.status, elapsedMs: elapsed }, "STARVELL_BALANCE_HTML");
        if (!resp.ok) continue;
        const html = await resp.text();
        const nextData = extractNextData(html);
        const profile = extractProfile(nextData?.props?.pageProps, this.logger);
        if (profile) return { ...profile, raw: nextData };
      } catch (err) {
        this.logger?.warn?.({ err, url: page }, "STARVELL_BALANCE_HTML_ERROR");
      }
    }
    throw new Error("STARVELL_PROFILE_HTML_UNAVAILABLE");
  }

  async getOfferByUrl(offerUrl: string): Promise<StarvellOfferInfo | null> {
    if (!offerUrl) return null;
    const offerId = extractOfferId(offerUrl);
    if (!offerId) return null;

    try {
      const resp = await fetch(`https://starvell.com/offers/${offerId}`, {
        headers: {
          cookie: this.cookie || "",
          "user-agent": "Mozilla/5.0",
          accept: "text/html",
        },
      });
      if (resp.ok) {
        const html = await resp.text();
        const nextData = extractNextData(html);
        const offerInfo = extractOfferFromNext(nextData);
        if (offerInfo) return { offerId, ...offerInfo, raw: offerInfo.raw ?? nextData };

        const priceFromHtml = extractPriceFromHtml(html);
        if (priceFromHtml) return { offerId, pricePerUnit: priceFromHtml };
      }
    } catch (err) {
      this.logger?.warn?.({ err, offerUrl }, "STARVELL_OFFER_FETCH_ERROR");
    }
    return { offerId };
  }
}

function normalizeCookie(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.includes("=")) return trimmed;
  return `session=${trimmed}`;
}

function extractOfferId(url: string): string | null {
  const match = url.match(/\/offers\/(\d+)/);
  return match?.[1] ?? null;
}

function extractProfile(
  data: any,
  logger?: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void }
): StarvellProfile | null {
  if (!data || typeof data !== "object") return null;
  const balance =
    data.balance ||
    data.user?.balance ||
    data.profile?.balance ||
    data.pageProps?.user?.balance ||
    data.pageProps?.profile?.balance;
  if (balance && typeof balance === "object") {
    const available = toNumber(balance.available ?? balance.free ?? balance.money ?? balance.balance);
    const pending = toNumber(balance.pending ?? balance.waiting);
    const frozen = toNumber(balance.frozen ?? balance.hold);
    return normalizeProfile({ available, pending, frozen }, logger);
  }

  const available = toNumber(data.available ?? data.balanceAvailable ?? data.balance_available);
  if (Number.isFinite(available)) return normalizeProfile({ available, pending: null, frozen: null }, logger);
  return null;
}

function normalizeProfile(
  input: { available: number | null; pending: number | null; frozen: number | null },
  logger?: { warn: (...args: any[]) => void }
): StarvellProfile {
  const available = input.available ?? 0;
  const pending = input.pending ?? 0;
  const frozen = input.frozen ?? 0;
  if (input.available === null) logger?.warn?.("STARVELL_BALANCE_MISSING available -> 0");
  if (input.pending === null) logger?.warn?.("STARVELL_BALANCE_MISSING pending -> 0");
  if (input.frozen === null) logger?.warn?.("STARVELL_BALANCE_MISSING frozen -> 0");
  return { available, pending, frozen };
}

function extractOfferFromNext(nextData: any): StarvellOfferInfo | null {
  const offer =
    nextData?.props?.pageProps?.offer ||
    nextData?.props?.pageProps?.offerDetails ||
    nextData?.props?.pageProps?.bff?.offer ||
    nextData?.props?.pageProps?.bff?.offerDetails;
  if (!offer || typeof offer !== "object") return null;

  const pricePerUnit =
    toNumber(offer.pricePerUnit ?? offer.price_per_unit ?? offer.unitPrice ?? offer.unit_price ?? offer.pricePerRobux) ??
    findNumberByKey(offer, ["pricePerUnit", "price_per_unit", "unitPrice", "unit_price", "pricePerRobux"]);
  const minQty =
    toNumber(offer.minQty ?? offer.min_qty ?? offer.minQuantity ?? offer.minimum) ??
    findNumberByKey(offer, ["minQty", "min_qty", "minQuantity", "minimum"]);

  if (pricePerUnit || minQty) {
    return { pricePerUnit: pricePerUnit ?? undefined, minQty: minQty ?? undefined, raw: offer };
  }
  return null;
}

function extractNextData(html: string): any | null {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function extractPriceFromHtml(html: string): number | null {
  const match = html.match(/от\s*([0-9]+[.,]?[0-9]*)\s*₽/i) || html.match(/([0-9]+[.,]?[0-9]*)\s*₽/i);
  if (!match?.[1]) return null;
  return toNumber(match[1]);
}

function toNumber(value: any): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/\s+/g, "").replace(",", ".");
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function findNumberByKey(obj: any, keys: string[]): number | null {
  if (!obj || typeof obj !== "object") return null;
  for (const key of Object.keys(obj)) {
    const value = (obj as any)[key];
    if (keys.includes(key)) {
      const num = toNumber(value);
      if (num !== null) return num;
    }
    if (typeof value === "object") {
      const nested = findNumberByKey(value, keys);
      if (nested !== null) return nested;
    }
  }
  return null;
}
