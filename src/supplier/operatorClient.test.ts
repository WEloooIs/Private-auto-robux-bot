import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { OperatorSupplierClient } from "./operatorClient";
import { OrderStatus } from "../orders/fsm";

vi.mock("../db/client", () => {
  return {
    prisma: {
      order: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      supplierTask: {
        create: vi.fn(),
      },
    },
  };
});

import { prisma } from "../db/client";

describe("OperatorSupplierClient insufficient funds", () => {
  beforeEach(() => {
    (prisma.order.findUnique as any).mockResolvedValue({ dealId: "deal-1" });
    (prisma.order.update as any).mockResolvedValue({});
    (prisma.supplierTask.create as any).mockResolvedValue({});
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("moves order to WAIT_TOPUP and throws on insufficient funds", async () => {
    const starvellRead = {
      isEnabled: () => true,
      getOfferByUrl: async () => ({ pricePerUnit: 1 }),
      getProfile: async () => ({ available: 10, pending: 0, frozen: 0 }),
    };
    const notifyOperator = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const client = new OperatorSupplierClient({ notifyOperator, logger, starvellRead: starvellRead as any });

    const request = {
      offer_url: "https://starvell.com/offers/115374",
      amount_robux: 20,
      roblox_username: "Test",
      gamepass_url: "https://roblox.com/game-pass/1",
      pay_method: "balance" as const,
      __orderId: "order-1",
      gamepass_id: "1",
    } as any;

    await expect(client.purchase(request)).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: { status: OrderStatus.WAIT_TOPUP, statusDetails: "INSUFFICIENT_FUNDS" },
    });
    expect(prisma.supplierTask.create).not.toHaveBeenCalled();
    expect(notifyOperator).toHaveBeenCalled();
  });
});
