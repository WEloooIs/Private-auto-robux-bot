export function extractNextData(html: string): any {
  const m = html.match(/__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
  if (!m) throw new Error("Не найден __NEXT_DATA__");
  return JSON.parse(m[1]);
}

export function getOfferIdFromUrl(url: string): number {
  const m = url.match(/\/offers\/(\d+)/);
  if (!m) throw new Error(`offerUrl должен содержать /offers/<id>: ${url}`);
  return Number(m[1]);
}

export function pickChatId(next: any): string | undefined {
  return next?.props?.pageProps?.chat?.id;
}

export function pickOrderArgIdForNickname(next: any): string | undefined {
  return next?.props?.pageProps?.offer?.category?.orderArgs?.[0]?.id;
}

function toNumber(value: any): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const cleaned = value.replace(/\s+/g, "").replace(",", ".");
    const num = Number.parseFloat(cleaned);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

export function pickRequiredRubDetailed(next: any, quantity: number): {
  value: number | null;
  source: string | null;
  tried: string[];
  failReason?: string;
} {
  const tried: string[] = [];
  const offer = next?.props?.pageProps?.offer;
  if (!offer || !Number.isFinite(quantity) || quantity <= 0) {
    return { value: null, source: null, tried, failReason: "offer or quantity missing" };
  }

  const totalCandidates: Array<[string, any]> = [
    ["offer.totalPriceRub", offer.totalPriceRub],
    ["offer.totalRub", offer.totalRub],
    ["offer.totalPrice", offer.totalPrice],
    ["offer.sumRub", offer.sumRub],
  ];
  for (const [path, c] of totalCandidates) {
    tried.push(path);
    const n = toNumber(c);
    if (n !== null) return { value: n, source: path, tried };
  }

  const unitCandidates: Array<[string, any]> = [
    ["offer.priceRub", offer.priceRub],
    ["offer.rubPrice", offer.rubPrice],
    ["offer.priceRUB", offer.priceRUB],
    ["offer.price", offer.price],
    ["offer.unitPrice", offer.unitPrice],
    ["offer.pricePerUnit", offer.pricePerUnit],
    ["offer.pricePerUnitRub", offer.pricePerUnitRub],
    ["offer.costRub", offer.costRub],
    ["offer.cost", offer.cost],
  ];
  for (const [path, c] of unitCandidates) {
    tried.push(path);
    const n = toNumber(c);
    if (n !== null) return { value: n * quantity, source: path, tried };
  }

  return { value: null, source: null, tried, failReason: "no price fields matched" };
}

export function pickRequiredRub(next: any, quantity: number): number | null {
  return pickRequiredRubDetailed(next, quantity).value;
}

export type ParsedMsg = { id: string; text: string; fromSeller: boolean };

export function parseMessages(next: any): ParsedMsg[] {
  const out: ParsedMsg[] = [];

  function walk(x: any) {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) {
      x.forEach(walk);
      return;
    }

    if (Array.isArray(x.messages)) {
      for (const m of x.messages) {
        const id = String(m?.id ?? "");
        const text = String(m?.content ?? m?.text ?? "");
        if (!id || !text) continue;

        const fromSeller = m?.senderType === "seller" || m?.authorType === "seller" || m?.userType === "seller";

        out.push({ id, text, fromSeller });
      }
    }

    for (const k of Object.keys(x)) walk(x[k]);
  }

  walk(next?.props?.pageProps);
  const uniq = new Map<string, ParsedMsg>();
  for (const m of out) uniq.set(m.id, m);
  return [...uniq.values()];
}
