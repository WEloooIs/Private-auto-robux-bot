import { prisma } from "../db/client";
import type { StarvellReadClient } from "../starvell/readClient";

export type BalanceSource = "supplier_api" | "starvell_api" | "html" | "manual";

export interface SupplierBalance {
  available: number;
  pending: number;
  frozen: number;
  source: BalanceSource;
  updatedAt: Date;
}

export class SupplierBalanceService {
  private readonly supplierBaseUrl: string;
  private readonly starvellRead?: StarvellReadClient;
  private readonly logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void };

  constructor(options: {
    supplierBaseUrl: string;
    starvellRead?: StarvellReadClient;
    logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void };
  }) {
    this.supplierBaseUrl = options.supplierBaseUrl;
    this.starvellRead = options.starvellRead;
    this.logger = options.logger;
  }

  async getBalance(forceRefresh = true): Promise<SupplierBalance> {
    const manual = await this.getManualSnapshot();
    if (manual) return manual;

    const supplier = await this.trySupplierApi(forceRefresh);
    if (supplier) return supplier;

    if (this.starvellRead) {
      const api = await this.tryStarvellApi();
      if (api) return api;
      const html = await this.tryStarvellHtml();
      if (html) return html;
    }

    throw new Error("BALANCE_UNAVAILABLE");
  }

  async setManualBalance(available: number, pending: number, frozen: number) {
    const snapshot = await prisma.supplierBalanceSnapshot.upsert({
      where: { id: "manual" },
      update: {
        available,
        pending,
        frozen,
        source: "manual",
      },
      create: {
        id: "manual",
        available,
        pending,
        frozen,
        source: "manual",
      },
    });
    return snapshot;
  }

  private async trySupplierApi(forceRefresh: boolean): Promise<SupplierBalance | null> {
    const endpoints = ["/balance", "/wallet", "/funds"];
    for (const path of endpoints) {
      const url = `${this.supplierBaseUrl}${path}`;
      const started = Date.now();
      try {
        const resp = await fetch(url, {
          headers: {
            "cache-control": forceRefresh ? "no-cache" : "max-age=60",
            accept: "application/json",
          },
        });
        const elapsed = Date.now() - started;
        this.logger.info({ url, status: resp.status, elapsedMs: elapsed }, "SUPPLIER_BALANCE_HTTP");
        if (!resp.ok) continue;
        const data = await resp.json();
        const normalized = normalizeBalanceResponse(data, this.logger);
        if (normalized) {
          return { ...normalized, source: "supplier_api", updatedAt: new Date() };
        }
      } catch (err) {
        this.logger.warn({ err, url }, "SUPPLIER_BALANCE_HTTP_ERROR");
      }
    }
    return null;
  }

  private async tryStarvellApi(): Promise<SupplierBalance | null> {
    try {
      const profile = await this.starvellRead!.getProfileApi();
      return {
        available: profile.available ?? 0,
        pending: profile.pending ?? 0,
        frozen: profile.frozen ?? 0,
        source: "starvell_api",
        updatedAt: new Date(),
      };
    } catch (err) {
      this.logger.warn({ err }, "STARVELL_BALANCE_API_FAILED");
      return null;
    }
  }

  private async tryStarvellHtml(): Promise<SupplierBalance | null> {
    try {
      const profile = await this.starvellRead!.getProfileHtml();
      if (profile.available === 0 && profile.pending === 0 && profile.frozen === 0) {
        this.logger.warn("STARVELL_HTML_BALANCE_ZERO");
        return null;
      }
      return {
        available: profile.available ?? 0,
        pending: profile.pending ?? 0,
        frozen: profile.frozen ?? 0,
        source: "html",
        updatedAt: new Date(),
      };
    } catch (err) {
      this.logger.warn({ err }, "STARVELL_BALANCE_HTML_FAILED");
      return null;
    }
  }

  private async getManualSnapshot(): Promise<SupplierBalance | null> {
    const snapshot = await prisma.supplierBalanceSnapshot.findUnique({ where: { id: "manual" } });
    if (!snapshot) return null;
    this.logger.warn("BALANCE_FALLBACK_MANUAL");
    return {
      available: snapshot.available,
      pending: snapshot.pending,
      frozen: snapshot.frozen,
      source: "manual",
      updatedAt: snapshot.updatedAt,
    };
  }
}

export function normalizeBalanceResponse(
  data: any,
  logger?: { warn: (...args: any[]) => void }
): { available: number; pending: number; frozen: number } | null {
  if (!data || typeof data !== "object") return null;
    const balance = data.balance || data.wallet || data.data || data.result || data.profile?.balance || data.pageProps?.balance;
  if (balance && typeof balance === "object") {
    return normalizeFields(
      balance.available ?? balance.free ?? balance.money ?? balance.balance,
      balance.pending ?? balance.waiting ?? balance.hold,
      balance.frozen ?? balance.locked,
      logger
    );
  }
  if ("available" in data || "pending" in data || "frozen" in data) {
    return normalizeFields(data.available, data.pending, data.frozen, logger);
  }
  return null;
}

function normalizeFields(
  availableRaw: any,
  pendingRaw: any,
  frozenRaw: any,
  logger?: { warn: (...args: any[]) => void }
) {
  const available = toNumber(availableRaw);
  const pending = toNumber(pendingRaw);
  const frozen = toNumber(frozenRaw);
  if (available === null) logger?.warn?.("BALANCE_FIELD_MISSING available -> 0");
  if (pending === null) logger?.warn?.("BALANCE_FIELD_MISSING pending -> 0");
  if (frozen === null) logger?.warn?.("BALANCE_FIELD_MISSING frozen -> 0");
  return {
    available: available ?? 0,
    pending: pending ?? 0,
    frozen: frozen ?? 0,
  };
}

function toNumber(value: any): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/\s+/g, "").replace(",", ".");
    const num = Number.parseFloat(cleaned);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}
