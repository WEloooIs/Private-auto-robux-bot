import { PrismaClient } from "@prisma/client";
import { OrderStatus } from "../orders/fsm";

type QueueLike = { enqueuePurchase: (orderId: string) => void };

export function startNoSuppliersSweeper(opts: {
  prisma: PrismaClient;
  queue: QueueLike;
  intervalMs?: number;
  logger: { info: (m: string) => void; warn: (m: string) => void; error: (e: any) => void };
}) {
  const intervalMs = opts.intervalMs ?? 60_000;

  const timer = setInterval(async () => {
    const now = Date.now();
    try {
      const candidates = await opts.prisma.order.findMany({
        where: { status: OrderStatus.SUPPLIER_PENDING },
        select: { id: true, statusDetails: true },
        take: 50,
      });

      let fired = 0;
      for (const o of candidates) {
        if (!o.statusDetails) continue;
        let details: any;
        try {
          details = JSON.parse(o.statusDetails);
        } catch {
          continue;
        }
        const nextRetryAt = details?.noSuppliersNextRetryAt;
        const retryCount = details?.noSuppliersRetryCount;
        const starvellOrderId = details?.starvellOrderId;

        if (typeof nextRetryAt !== "number") continue;
        if (typeof retryCount !== "number") continue;
        if (starvellOrderId) continue;
        if (nextRetryAt <= now) {
          opts.queue.enqueuePurchase(o.id);
          fired++;
        }
      }

      if (fired > 0) {
        opts.logger.info(`NO_SUPPLIERS_SWEEPER fired=${fired}`);
      }
    } catch (e) {
      opts.logger.error(e);
    }
  }, intervalMs);

  opts.logger.info(`NO_SUPPLIERS_SWEEPER started intervalMs=${intervalMs}`);

  return () => clearInterval(timer);
}
