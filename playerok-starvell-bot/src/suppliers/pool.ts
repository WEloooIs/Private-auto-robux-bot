import fs from "fs";
import path from "path";
import { AsyncQueue } from "../worker/asyncQueue";
import { extractNextData, pickRequiredRubDetailed } from "../starvell/nextData";

export type SupplierConfig = {
  maxConcurrency: number;
  maxUnitPriceRub: number;
  refreshPriceMs?: number;
  priceSpreadRub?: number;
  suppliers: Array<{ id: string; offerUrl: string; enabled: boolean }>;
};

type SupplierRuntime = {
  id: string;
  offerUrl: string;
  enabled: boolean;
  queue: AsyncQueue;
  lastUnitPriceRub?: number;
  lastCheckedAt?: number;
  lastRequiredRub?: number;
  lastError?: string;
  lastErrorAt?: number;
  errorCount?: number;
  disabledUntil?: number;
  skipUntil?: number;
  lastNoPriceReason?: string;
};

type Logger = { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void };

const DEFAULT_CONFIG_PATH = path.join(process.cwd(), "config", "suppliers.json");
const FALLBACK_MAX_CONCURRENCY = 1;
const FALLBACK_MAX_UNIT_PRICE = 0.6;
const PRICE_TTL_MS = 60_000;
const PRICE_SPREAD_RUB = 0.02;
const ERROR_THRESHOLD = 3;
const DISABLE_MS = 10 * 60 * 1000;

export function loadSuppliersConfig(): SupplierConfig {
  const configPath = process.env.SUPPLIERS_CONFIG
    ? path.resolve(process.env.SUPPLIERS_CONFIG)
    : DEFAULT_CONFIG_PATH;

  if (!fs.existsSync(configPath)) {
    const fallback: SupplierConfig = {
      maxConcurrency: Number.parseInt(process.env.SUPPLIERS_MAX_CONCURRENCY ?? "", 10) || FALLBACK_MAX_CONCURRENCY,
      maxUnitPriceRub: Number.parseFloat(process.env.SUPPLIERS_MAX_UNIT_PRICE_RUB ?? "") || FALLBACK_MAX_UNIT_PRICE,
      refreshPriceMs: Number.parseInt(process.env.SUPPLIERS_REFRESH_PRICE_MS ?? "", 10) || PRICE_TTL_MS,
      priceSpreadRub: Number.parseFloat(process.env.SUPPLIERS_PRICE_SPREAD_RUB ?? "") || PRICE_SPREAD_RUB,
      suppliers: [],
    };
    const fallbackOffer = (process.env.DEFAULT_OFFER_URL ?? "").trim();
    if (fallbackOffer) {
      fallback.suppliers.push({ id: "default", offerUrl: fallbackOffer, enabled: true });
    }
    return fallback;
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as SupplierConfig;
  const cfg = {
    maxConcurrency: parsed.maxConcurrency ?? FALLBACK_MAX_CONCURRENCY,
    maxUnitPriceRub: parsed.maxUnitPriceRub ?? FALLBACK_MAX_UNIT_PRICE,
    refreshPriceMs: parsed.refreshPriceMs ?? PRICE_TTL_MS,
    priceSpreadRub: parsed.priceSpreadRub ?? PRICE_SPREAD_RUB,
    suppliers: parsed.suppliers ?? [],
  };
  if (!cfg.suppliers.length) {
    const fallbackOffer = (process.env.DEFAULT_OFFER_URL ?? "").trim();
    if (fallbackOffer) {
      cfg.suppliers.push({ id: "default", offerUrl: fallbackOffer, enabled: true });
    }
  }
  return cfg;
}

async function fetchOfferNextData(offerUrl: string): Promise<any> {
  const resp = await fetch(offerUrl, { method: "GET" });
  if (!resp.ok) {
    throw new Error(`Offer fetch failed: ${resp.status} ${resp.statusText}`);
  }
  const html = await resp.text();
  return extractNextData(html);
}

export class SupplierPool {
  private cfg: SupplierConfig;
  private readonly suppliers: SupplierRuntime[];
  private active = 0;
  private readonly logger: Logger;
  private rrCounter = 0;
  private lastFilterLogAt?: number;

  constructor(cfg: SupplierConfig, logger: Logger) {
    this.cfg = cfg;
    this.logger = logger;
    this.suppliers = cfg.suppliers.map((s) => ({
      id: s.id,
      offerUrl: s.offerUrl,
      enabled: s.enabled !== false,
      queue: new AsyncQueue(),
    }));
  }

  totalQueued(): number {
    return this.suppliers.reduce((acc, s) => acc + s.queue.size(), 0);
  }

  private async getUnitPriceRub(
    offerUrl: string,
    netRobux: number
  ): Promise<{ unitPrice: number; requiredRub: number } | null> {
    const next = await fetchOfferNextData(offerUrl);
    const requiredRubInfo = pickRequiredRubDetailed(next, netRobux);
    if (requiredRubInfo.value === null) return null;
    if (!Number.isFinite(netRobux) || netRobux <= 0) return null;
    const requiredRub = requiredRubInfo.value;
    return { unitPrice: requiredRub / netRobux, requiredRub };
  }

  private async refreshSupplierPrice(s: SupplierRuntime, netRobux: number, force = false): Promise<void> {
    const now = Date.now();
    const ttl = this.cfg.refreshPriceMs ?? PRICE_TTL_MS;
    if (!force && s.lastCheckedAt && now - s.lastCheckedAt < ttl && s.lastUnitPriceRub !== undefined) {
      return;
    }
    try {
      const price = await this.getUnitPriceRub(s.offerUrl, netRobux);
      if (price && Number.isFinite(price.unitPrice)) {
        s.lastUnitPriceRub = price.unitPrice;
        s.lastCheckedAt = now;
        s.lastRequiredRub = price.requiredRub;
        s.lastError = undefined;
        s.lastErrorAt = undefined;
        s.errorCount = 0;
        s.disabledUntil = undefined;
        s.skipUntil = undefined;
        s.lastNoPriceReason = undefined;
      } else {
        s.lastUnitPriceRub = undefined;
        s.lastCheckedAt = now;
        s.lastNoPriceReason = "requiredRub not found";
      }
    } catch (err) {
      const msg = String((err as any)?.message ?? err);
      this.logger.warn({ err, offerUrl: s.offerUrl }, "SUPPLIER_PRICE_FETCH_FAILED");
      s.lastError = msg;
      s.lastErrorAt = now;
      s.errorCount = (s.errorCount ?? 0) + 1;
      if ((s.errorCount ?? 0) >= ERROR_THRESHOLD) {
        s.disabledUntil = now + DISABLE_MS;
      } else {
        s.skipUntil = now + (this.cfg.refreshPriceMs ?? PRICE_TTL_MS);
      }
      s.lastCheckedAt = now;
    }
  }

  async pickSupplier(netRobux: number): Promise<SupplierRuntime> {
    const max = this.cfg.maxUnitPriceRub ?? FALLBACK_MAX_UNIT_PRICE;
    for (const s of this.suppliers) {
      if (!s.enabled) continue;
      if (s.disabledUntil && s.disabledUntil > Date.now()) continue;
      await this.refreshSupplierPrice(s, netRobux);
    }

    const now = Date.now();
    const eligibleFresh = this.suppliers.filter(
      (s) =>
        s.enabled &&
        (!s.disabledUntil || s.disabledUntil <= now) &&
        (!s.skipUntil || s.skipUntil <= now) &&
        s.lastUnitPriceRub !== undefined &&
        s.lastUnitPriceRub <= max
    );

    const eligibleStale = this.suppliers.filter(
      (s) =>
        s.enabled &&
        (!s.disabledUntil || s.disabledUntil <= now) &&
        s.lastUnitPriceRub !== undefined &&
        s.lastUnitPriceRub <= max
    );

    const eligible = eligibleFresh.length ? eligibleFresh : eligibleStale;

    if (!eligible.length) {
      const snapshot = this.suppliers.map((s) => ({
        id: s.id,
        enabled: s.enabled,
        unitPriceRub: s.lastUnitPriceRub ?? null,
        disabledUntil: s.disabledUntil ?? null,
        lastError: s.lastError ?? null,
        reason: this.getFilterReason(s, max),
      }));
      const nowLog = Date.now();
      if (!this.lastFilterLogAt || nowLog - this.lastFilterLogAt > 5000) {
        for (const s of this.suppliers) {
          const reason = this.getFilterReason(s, max);
          this.logger.info({ supplier: s.id, reason }, "SUPPLIER_FILTER");
        }
        this.lastFilterLogAt = nowLog;
      }
      const err = new Error(`NO_ELIGIBLE_SUPPLIERS: ${JSON.stringify(snapshot)}`);
      (err as any).code = "NO_ELIGIBLE_SUPPLIERS";
      throw err;
    }

    eligible.sort((a, b) => a.lastUnitPriceRub! - b.lastUnitPriceRub!);
    const spread = this.cfg.priceSpreadRub ?? PRICE_SPREAD_RUB;
    const min = eligible[0].lastUnitPriceRub!;
    const near = eligible.filter((s) => s.lastUnitPriceRub! <= min + spread);
    const idx = this.rrCounter++ % near.length;
    return near[idx];
  }

  getSupplierById(id: string): SupplierRuntime | undefined {
    return this.suppliers.find((s) => s.id === id);
  }

  async pickSupplierForOrder(netRobux: number, preferredId?: string): Promise<SupplierRuntime> {
    if (preferredId) {
      const preferred = this.getSupplierById(preferredId);
      if (preferred) {
        await this.refreshSupplierPrice(preferred, netRobux);
        const reason = this.getFilterReason(preferred, this.cfg.maxUnitPriceRub ?? FALLBACK_MAX_UNIT_PRICE);
        if (reason === "OK") return preferred;
        this.logger.info({ supplier: preferred.id, reason }, "SUPPLIER_STICKY_SKIPPED");
      }
    }
    return this.pickSupplier(netRobux);
  }

  async forceRefresh(id?: string, netRobux = 100): Promise<void> {
    if (id) {
      const s = this.getSupplierById(id);
      if (!s) throw new Error(`SUPPLIER_NOT_FOUND: ${id}`);
      this.invalidateCache(id);
      await this.refreshSupplierPrice(s, netRobux, true);
      return;
    }
    for (const s of this.suppliers) {
      if (!s.enabled) continue;
      this.invalidateCache(s.id);
      await this.refreshSupplierPrice(s, netRobux, true);
    }
  }

  invalidateCache(id?: string) {
    const list = id ? [this.getSupplierById(id)].filter(Boolean) as SupplierRuntime[] : this.suppliers;
    for (const s of list) {
      s.lastCheckedAt = undefined;
      s.lastUnitPriceRub = undefined;
      s.lastRequiredRub = undefined;
      s.lastError = undefined;
      s.lastErrorAt = undefined;
      s.lastNoPriceReason = undefined;
      s.errorCount = 0;
      s.skipUntil = undefined;
    }
  }

  private getFilterReason(s: SupplierRuntime, max: number): string {
    const now = Date.now();
    if (!s.enabled) return "DISABLED: config.enabled=false";
    if (s.disabledUntil && s.disabledUntil > now)
      return `TEMP_DISABLED: SSR_FAIL x${s.errorCount ?? 0} until ${new Date(s.disabledUntil).toLocaleTimeString(
        "ru-RU"
      )}`;
    if (s.lastUnitPriceRub === undefined)
      return `NO_PRICE: ${s.lastNoPriceReason ?? "requiredRub not found"}`;
    if (s.lastUnitPriceRub > max) return `TOO_EXPENSIVE: ${s.lastUnitPriceRub.toFixed(3)} > ${max.toFixed(3)}`;
    return "OK";
  }

  private async waitForSlot() {
    const max = this.cfg.maxConcurrency ?? FALLBACK_MAX_CONCURRENCY;
    while (this.active >= max) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async enqueueOnSupplier<T>(supplier: SupplierRuntime, jobId: string, job: () => Promise<T>): Promise<T> {
    return supplier.queue.enqueue(jobId, async () => {
      await this.waitForSlot();
      this.active += 1;
      try {
        return await job();
      } finally {
        this.active -= 1;
      }
    });
  }

  getSnapshot() {
    const now = Date.now();
    return {
      maxConcurrency: this.cfg.maxConcurrency ?? FALLBACK_MAX_CONCURRENCY,
      maxUnitPriceRub: this.cfg.maxUnitPriceRub ?? FALLBACK_MAX_UNIT_PRICE,
      refreshPriceMs: this.cfg.refreshPriceMs ?? PRICE_TTL_MS,
      active: this.active,
      suppliers: this.suppliers.map((s) => ({
        id: s.id,
        enabled: s.enabled,
        offerUrl: s.offerUrl,
        unitPriceRub: s.lastUnitPriceRub ?? null,
        requiredRub: s.lastRequiredRub ?? null,
        lastCheckedAt: s.lastCheckedAt ?? null,
        lastError: s.lastError ?? null,
        disabledUntil: s.disabledUntil ?? null,
        skipUntil: s.skipUntil ?? null,
        reason: this.getFilterReason(s, this.cfg.maxUnitPriceRub ?? FALLBACK_MAX_UNIT_PRICE),
        queueSize: s.queue.size(),
        status:
          !s.enabled
            ? "DISABLED"
            : s.disabledUntil && s.disabledUntil > now
            ? "TEMP_DISABLED"
            : s.lastUnitPriceRub !== undefined && s.lastUnitPriceRub > (this.cfg.maxUnitPriceRub ?? FALLBACK_MAX_UNIT_PRICE)
            ? "TOO_EXPENSIVE"
            : s.lastUnitPriceRub === undefined
            ? "NO_PRICE"
            : "OK",
      })),
    };
  }

  applyConfig(cfg: SupplierConfig) {
    this.cfg.maxConcurrency = cfg.maxConcurrency ?? this.cfg.maxConcurrency;
    this.cfg.maxUnitPriceRub = cfg.maxUnitPriceRub ?? this.cfg.maxUnitPriceRub;
    this.cfg.refreshPriceMs = cfg.refreshPriceMs ?? this.cfg.refreshPriceMs;
    this.cfg.priceSpreadRub = cfg.priceSpreadRub ?? this.cfg.priceSpreadRub;

    const existingById = new Map(this.suppliers.map((s) => [s.id, s]));
    const nextSuppliers: SupplierRuntime[] = [];
    for (const s of cfg.suppliers ?? []) {
      const prev = existingById.get(s.id);
      if (prev) {
        prev.offerUrl = s.offerUrl;
        prev.enabled = s.enabled !== false;
        nextSuppliers.push(prev);
      } else {
        nextSuppliers.push({
          id: s.id,
          offerUrl: s.offerUrl,
          enabled: s.enabled !== false,
          queue: new AsyncQueue(),
        });
      }
    }
    this.suppliers.length = 0;
    this.suppliers.push(...nextSuppliers);
  }
}
