import { prisma } from "../db/client";
import { OrderStatus } from "../orders/fsm";
import type { SupplierClient, SupplierStatus } from "../supplier/client";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface QueueDependencies {
  supplier: SupplierClient;
  logger: { info: (...args: any[]) => void; error: (...args: any[]) => void; warn: (...args: any[]) => void };
  notifyBuyer: (chatId: string, message: string) => Promise<void>;
  completeDeal: (dealId: string) => Promise<void>;
  notifyOperator?: (message: string) => Promise<void>;
}

export class InProcessQueue {
  private readonly deps: QueueDependencies;
  private readonly activePurchases = new Set<string>();
  private readonly activePolls = new Map<string, NodeJS.Timeout>();

  constructor(deps: QueueDependencies) {
    this.deps = deps;
  }

  enqueuePurchase(orderId: string) {
    if (this.activePurchases.has(orderId)) return;
    this.activePurchases.add(orderId);
    void this.purchaseFlow(orderId).finally(() => {
      this.activePurchases.delete(orderId);
    });
  }

  startPolling(orderId: string, supplierOrderId: string) {
    if (this.activePolls.has(orderId)) return;
    const startedAt = Date.now();
    const interval = setInterval(async () => {
      try {
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs > 20 * 60 * 1000) {
          await this.failOrder(orderId, "Supplier timeout");
          this.stopPolling(orderId);
          return;
        }

        const statusResponse = await this.deps.supplier.status(supplierOrderId);
        if (statusResponse.status === "PENDING") return;

        if (statusResponse.status === "DONE") {
          await this.markDone(orderId);
          this.stopPolling(orderId);
          return;
        }

        if (statusResponse.status === "FAILED") {
          await this.failOrder(orderId, statusResponse.details ?? "Supplier failed");
          this.stopPolling(orderId);
        }
      } catch (err) {
        this.deps.logger.error({ err }, "Supplier status poll failed");
      }
    }, 30_000);

    this.activePolls.set(orderId, interval);
  }

  stopPolling(orderId: string) {
    const timer = this.activePolls.get(orderId);
    if (timer) clearInterval(timer);
    this.activePolls.delete(orderId);
  }

  private async purchaseFlow(orderId: string) {
    try {
      const order = await prisma.order.findUnique({ where: { id: orderId } });
      if (!order || order.status !== OrderStatus.READY_TO_BUY) return;
      if (!order.robloxUsername || !order.gamepassUrl || !order.gamepassId) return;

      const purchaseRequest = {
        offer_url: order.offerUrl,
        amount_robux: order.amountRobux,
        roblox_username: order.robloxUsername,
        gamepass_url: order.gamepassUrl,
        pay_method: "balance" as const,
      };
      (purchaseRequest as any).__orderId = order.id;
      (purchaseRequest as any).gamepass_id = order.gamepassId;

      let supplierOrderId = "";
      const backoffMs = [1000, 3000, 7000];

      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await this.deps.supplier.purchase(purchaseRequest);
          supplierOrderId = response.supplier_order_id;
          this.deps.logger.info(`Supplier purchase created deal_id=${order.dealId} supplier_order_id=${supplierOrderId}`);
          break;
        } catch (err) {
          const code = (err as any)?.code;
          if (code === "INSUFFICIENT_FUNDS") {
            this.deps.logger.warn({ err }, "Insufficient funds; order moved to WAIT_TOPUP");
            const latestTask = await prisma.supplierTask.findFirst({
              where: { orderId },
              orderBy: { updatedAt: "desc" },
            });
            const msg = `❌ Недостаточно средств: баланс ${(err as any)?.balance ?? "-"}₽, стоимость ${(err as any)?.cost ?? "-"}₽. taskId=${latestTask?.id ?? "-"}`;
            await prisma.order.update({
              where: { id: orderId },
              data: {
                status: OrderStatus.WAIT_TOPUP,
                statusDetails: "INSUFFICIENT_FUNDS",
                lastErrorCode: "INSUFFICIENT_FUNDS",
                lastErrorMessage: msg,
                nextAction: "TOPUP_AND_RETRY",
                retryCount: { increment: 1 },
              },
            });
            if (this.deps.notifyOperator) {
              await this.deps.notifyOperator(msg);
            }
            return;
          }
          this.deps.logger.warn({ err, attempt }, "Supplier purchase attempt failed");
          if (attempt === 2) {
            await this.markSupplierError(orderId, "SUPPLIER_PURCHASE_FAILED", (err as any)?.message ?? "Supplier purchase failed");
            return;
          }
          await sleep(backoffMs[attempt]);
        }
      }

      await prisma.order.update({
        where: { id: orderId },
        data: {
          supplierOrderId,
          status: OrderStatus.SUPPLIER_PENDING,
          statusDetails: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          nextAction: null,
        },
      });
      this.deps.logger.info(`Order status ${order.dealId}: ${OrderStatus.READY_TO_BUY} -> ${OrderStatus.SUPPLIER_PENDING}`);

      this.startPolling(orderId, supplierOrderId);
    } catch (err) {
      this.deps.logger.error({ err }, "purchaseFlow crashed");
      await this.markSupplierError(orderId, "PURCHASE_FLOW_ERROR", (err as any)?.message ?? "purchaseFlow error");
    }
  }

  private async markDone(orderId: string) {
    const current = await prisma.order.findUnique({ where: { id: orderId } });
    const order = await prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.DONE, statusDetails: null },
    });
    this.deps.logger.info(
      `Order status ${order.dealId}: ${current?.status ?? OrderStatus.SUPPLIER_PENDING} -> ${OrderStatus.DONE} supplier_order_id=${order.supplierOrderId ?? "-"}`
    );

    await this.deps.notifyBuyer(order.chatId, "Заказ выполнен ✅");
    await this.deps.completeDeal(order.dealId);
  }

  private async failOrder(orderId: string, details: string) {
    const current = await prisma.order.findUnique({ where: { id: orderId } });
    const order = await prisma.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.FAILED,
        statusDetails: details,
        lastErrorCode: "FAILED",
        lastErrorMessage: details,
        nextAction: null,
      },
    });
    this.deps.logger.warn(
      `Order status ${order.dealId}: ${current?.status ?? "-"} -> ${OrderStatus.FAILED} supplier_order_id=${order.supplierOrderId ?? "-"}`
    );

    await this.deps.notifyBuyer(
      order.chatId,
      "Не удалось выполнить автоматически. Пришлите ник, ссылку на геймпасс и ID пасса."
    );
  }

  private async markSupplierError(orderId: string, code: string, message: string) {
    const current = await prisma.order.findUnique({ where: { id: orderId } });
    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.SUPPLIER_ERROR,
        statusDetails: message,
        lastErrorCode: code,
        lastErrorMessage: message,
        nextAction: "RETRY",
        retryCount: { increment: 1 },
      },
    });
    this.deps.logger.warn(
      `Order status ${current?.dealId ?? "-"}: ${current?.status ?? "-"} -> ${OrderStatus.SUPPLIER_ERROR}`
    );
    if (this.deps.notifyOperator) {
      await this.deps.notifyOperator(`❌ Ошибка поставщика: ${message} orderId=${orderId}`);
    }
  }
}
