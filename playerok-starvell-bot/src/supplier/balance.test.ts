import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { normalizeBalanceResponse, SupplierBalanceService } from "./balance";

vi.mock("../db/client", () => {
  return {
    prisma: {
      supplierBalanceSnapshot: {
        findUnique: vi.fn(),
      },
    },
  };
});

import { prisma } from "../db/client";

describe("normalizeBalanceResponse", () => {
  it("maps nested balance fields to numbers", () => {
    const res = normalizeBalanceResponse({ balance: { available: "10.5", pending: "1", frozen: 0 } });
    expect(res).toEqual({ available: 10.5, pending: 1, frozen: 0 });
  });
});

describe("SupplierBalanceService fallback", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it("uses manual snapshot when auto sources fail", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValue(new Error("network"));
    (prisma.supplierBalanceSnapshot.findUnique as any).mockResolvedValue({
      id: "manual",
      available: 5,
      pending: 0,
      frozen: 0,
      source: "manual",
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const service = new SupplierBalanceService({
      supplierBaseUrl: "http://localhost:4000",
      starvellRead: {
        getProfileApi: async () => {
          throw new Error("no");
        },
        getProfileHtml: async () => {
          throw new Error("no");
        },
      } as any,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const balance = await service.getBalance(true);
    expect(balance.source).toBe("manual");
    expect(balance.available).toBe(5);
  });
});
