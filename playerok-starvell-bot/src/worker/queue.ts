import { prisma } from "../db/client";
import { OrderStatus } from "../orders/fsm";
import { runBuyRobux } from "../starvell/flowBuyRobux";
import { SupplierPool } from "../suppliers/pool";

export interface QueueDependencies {
  logger: { info: (...args: any[]) => void; error: (...args: any[]) => void; warn: (...args: any[]) => void };
  notifyBuyer: (chatId: string, message: string) => Promise<void>;
  completeDeal: (dealId: string) => Promise<void>;
  notifyOperator?: (message: string) => Promise<void>;
  supplierPool: SupplierPool;
}

type OrderDetails = {
  starvellOrderId?: string;
  lastSeenMessageId?: string;
  offerId?: number;
  netRobux?: number;
  grossRobux?: number;
  quantity?: number;
  chatId?: string;
  requiredRub?: number | null;
  requiredRubSource?: string | null;
  requiredRubExtract?: { tried: string[]; failReason?: string };
  creatingStarvellOrder?: boolean;
  creatingStartedAt?: number;
  supplierId?: string;
  supplierOfferUrl?: string;
  unitPriceRub?: number;
  noSuppliersRetryCount?: number;
  noSuppliersNextRetryAt?: number;
  noSuppliersFirstAt?: number;
};

function readDetails(details: string | null): OrderDetails {
  if (!details) return {};
  try {
    const obj = JSON.parse(details);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function writeDetails(details: string | null, patch: Partial<OrderDetails>): string {
  const base = readDetails(details);
  return JSON.stringify({ ...base, ...patch });
}

export class InProcessQueue {
  private readonly deps: QueueDependencies;
  private readonly activePurchases = new Set<string>();

  constructor(deps: QueueDependencies) {
    this.deps = deps;
  }

  enqueuePurchase(orderId: string) {
    if (this.activePurchases.has(orderId)) return;
    this.activePurchases.add(orderId);
    void this.purchaseFlow(orderId)
      .finally(() => {
        this.activePurchases.delete(orderId);
      });
  }

  size() {
    return this.deps.supplierPool.totalQueued();
  }

  getSupplierSnapshot() {
    return this.deps.supplierPool.getSnapshot();
  }

  forceRefreshSuppliers(id?: string, netRobux = 100) {
    return this.deps.supplierPool.forceRefresh(id, netRobux);
  }

  private async purchaseFlow(orderId: string) {
    const startedAt = Date.now();
    try {
      const order = await prisma.order.findUnique({ where: { id: orderId } });
      if (!order || order.status !== OrderStatus.READY_TO_BUY) return;
      if (!order.robloxUsername || !order.gamepassUrl || !order.gamepassId) return;

      const details = readDetails(order.statusDetails);
      const existingStarvellOrderId = details.starvellOrderId;
      const lastSeenMessageId = details.lastSeenMessageId;
      const preferredSupplierId = details.supplierId;
      if (details.creatingStarvellOrder && !existingStarvellOrderId) {
        await this.markSupplierError(
          orderId,
          "STARVELL_ORDER_UNKNOWN",
          "Starvell order creation was in-progress before restart. Manual check required."
        );
        return;
      }

      let supplier;
      try {
        supplier = await this.deps.supplierPool.pickSupplierForOrder(order.amountRobux, preferredSupplierId);
      } catch (err: any) {
        const code = err?.code ?? "NO_ELIGIBLE_SUPPLIERS";
        const message = err?.message ?? "No eligible suppliers";
        if (code === "NO_ELIGIBLE_SUPPLIERS") {
          await this.handleNoSuppliers(orderId, message);
          return;
        }
        await this.markSupplierError(orderId, code, message);
        await this.deps.notifyBuyer(order.chatId, "Сейчас нет доступных поставщиков. Попробуйте позже.");
        return;
      }

      if (details.noSuppliersRetryCount && details.noSuppliersRetryCount > 0) {
        this.deps.logger.info(
          { orderId, attempt: details.noSuppliersRetryCount, supplierId: supplier.id },
          "NO_SUPPLIERS_RECOVERED"
        );
      }

      await prisma.order.update({
        where: { id: orderId },
        data: {
          status: OrderStatus.SUPPLIER_PENDING,
          statusDetails: writeDetails(order.statusDetails, {
            noSuppliersRetryCount: 0,
            noSuppliersNextRetryAt: null,
            noSuppliersFirstAt: null,
          } as any),
          lastErrorCode: null,
          lastErrorMessage: null,
          nextAction: null,
        },
      });
      this.deps.logger.info({ orderId, starvellOrderId: existingStarvellOrderId }, "FLOW_START");

      if (!existingStarvellOrderId) {
        const reserveDetails = writeDetails(order.statusDetails, {
          creatingStarvellOrder: true,
          creatingStartedAt: Date.now(),
        });
        await prisma.order.update({ where: { id: orderId }, data: { statusDetails: reserveDetails } });
      }

      const ahead = supplier.queue.size();
      await this.deps.notifyBuyer(order.chatId, `Заявка принята. Перед вами в очереди: ${ahead}.`);

      const result = await this.deps.supplierPool.enqueueOnSupplier(supplier, orderId, async () => {
        return runBuyRobux(
          {
            offerUrl: supplier.offerUrl,
            quantity: order.amountRobux,
            buyerNick: order.robloxUsername!,
            gamepassUrl: order.gamepassUrl!,
            netRobux: order.amountRobux,
          },
          {
            notifyBuyer: (text) => this.deps.notifyBuyer(order.chatId, text),
            log: (text) =>
              this.deps.logger.info({ orderId, starvellOrderId: existingStarvellOrderId, supplier: supplier.id }, text),
            onState: async (state) => {
              const current = await prisma.order.findUnique({ where: { id: orderId } });
              const nextDetails = writeDetails(current?.statusDetails ?? order.statusDetails, {
                starvellOrderId: state.orderId ?? existingStarvellOrderId,
                lastSeenMessageId: state.lastSeenMessageId ?? lastSeenMessageId,
                offerId: state.offerId,
                netRobux: state.netRobux,
                grossRobux: state.grossRobux,
                quantity: state.quantity,
                chatId: state.chatId,
                requiredRub: state.requiredRub,
                requiredRubSource: state.requiredRubSource,
                requiredRubExtract: state.requiredRubExtract,
                creatingStarvellOrder: state.orderId ? false : details.creatingStarvellOrder,
                supplierId: supplier.id,
                supplierOfferUrl: supplier.offerUrl,
                unitPriceRub: supplier.lastUnitPriceRub,
              });
              await prisma.order.update({ where: { id: orderId }, data: { statusDetails: nextDetails } });
            },
            onError: async (code, message) => {
              await this.markSupplierError(orderId, code, message);
            },
          },
          {
            existingOrderId: existingStarvellOrderId,
            lastSeenMessageId,
          }
        );
      });

      if (result.orderId && result.orderId !== existingStarvellOrderId) {
        const nextDetails = writeDetails(order.statusDetails, {
          starvellOrderId: result.orderId,
          creatingStarvellOrder: false,
        });
        await prisma.order.update({ where: { id: orderId }, data: { statusDetails: nextDetails } });
      }

      if (result.status === "SELLER_DONE") {
        await this.markDone(orderId);
        this.deps.logger.info({ orderId, starvellOrderId: result.orderId, elapsedMs: Date.now() - startedAt }, "FLOW_DONE");
        return;
      }

      if (result.status === "TIMEOUT" || result.status === "CANCELED" || result.status === "REFUNDED") {
        await this.failOrder(orderId, `Starvell ${result.status}`);
        this.deps.logger.warn({ orderId, starvellOrderId: result.orderId, reason: result.status }, "FLOW_FAILED");
        return;
      }

      // оставляем SUPPLIER_PENDING, если статус неопределён
      this.deps.logger.info({ orderId, starvellOrderId: result.orderId, status: result.status }, "FLOW_PENDING");
    } catch (err) {
      this.deps.logger.error({ err, orderId }, "purchaseFlow crashed");
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

    await this.deps.notifyBuyer(
      order.chatId,
      "ВАЖНО: подтверждение нужно сделать вручную на Playerok.\n\nВсе выполнено, подтвердите заказ вручную в Playerok. Спасибо за покупку!"
    );
  }

  private async failOrder(orderId: string, details: string) {
    const current = await prisma.order.findUnique({ where: { id: orderId } });
    const nextDetails = writeDetails(current?.statusDetails ?? null, { creatingStarvellOrder: false });
    const order = await prisma.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.FAILED,
        statusDetails: nextDetails,
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
    const nextDetails = writeDetails(current?.statusDetails ?? null, { creatingStarvellOrder: false });
    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.SUPPLIER_ERROR,
        statusDetails: nextDetails,
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

  private async handleNoSuppliers(orderId: string, message: string) {
    const current = await prisma.order.findUnique({ where: { id: orderId } });
    if (!current) return;

    const details = readDetails(current.statusDetails);
    const now = Date.now();
    if (details.noSuppliersNextRetryAt && details.noSuppliersNextRetryAt > now) {
      return;
    }
    const firstAt = details.noSuppliersFirstAt ?? now;
    const ttlMs = 2 * 60 * 60 * 1000;
    const retryCount = (details.noSuppliersRetryCount ?? 0) + 1;
    const maxRetries = 6;
    const scheduleMin = [5, 7, 10, 15, 20, 30];
    const idx = Math.min(retryCount - 1, scheduleMin.length - 1);
    const delayMs = scheduleMin[idx] * 60 * 1000;
    const nextRetryAt = now + delayMs;

    const updatedDetails = writeDetails(current.statusDetails, {
      noSuppliersRetryCount: retryCount,
      noSuppliersNextRetryAt: nextRetryAt,
      noSuppliersFirstAt: firstAt,
    });

    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.SUPPLIER_PENDING,
        statusDetails: updatedDetails,
        lastErrorCode: "NO_ELIGIBLE_SUPPLIERS",
        lastErrorMessage: message,
        nextAction: "RETRY",
      },
    });

    if (retryCount === 1) {
      await this.deps.notifyBuyer(
        current.chatId,
        "Сейчас нет доступных поставщиков. Попробую ещё раз автоматически."
      );
    }

    if (now - firstAt > ttlMs) {
      await this.failOrder(orderId, "Нет доступных поставщиков. Попробуйте позже.");
      return;
    }

    if (retryCount > maxRetries) {
      await this.failOrder(orderId, "Нет доступных поставщиков. Попробуйте позже.");
      return;
    }

    this.deps.logger.info(
      { orderId, attempt: retryCount, nextRetryAt },
      "NO_SUPPLIERS_RETRY"
    );

    const waitMs = Math.max(0, nextRetryAt - now);
    setTimeout(() => {
      this.enqueuePurchase(orderId);
    }, waitMs);
  }
}
