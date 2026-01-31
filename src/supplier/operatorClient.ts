import crypto from "crypto";
import { prisma } from "../db/client";
import type { SupplierClient, SupplierPurchaseRequest, SupplierPurchaseResponse, SupplierStatusResponse } from "./client";
import type { StarvellReadClient } from "../starvell/readClient";
import { OrderStatus } from "../orders/fsm";

export interface OperatorSupplierOptions {
  notifyOperator: (message: string) => Promise<void>;
  logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void };
  starvellRead?: StarvellReadClient;
  balanceService?: { getBalance: (forceRefresh?: boolean) => Promise<{ available: number }>; setManualBalance?: any };
}

class InsufficientFundsError extends Error {
  code = "INSUFFICIENT_FUNDS";
  balance: number;
  cost: number;
  constructor(balance: number, cost: number) {
    super("INSUFFICIENT_FUNDS");
    this.balance = balance;
    this.cost = cost;
  }
}

export class OperatorSupplierClient implements SupplierClient {
  private readonly notifyOperator: OperatorSupplierOptions["notifyOperator"];
  private readonly logger: OperatorSupplierOptions["logger"];
  private readonly starvellRead?: StarvellReadClient;
  private readonly balanceService?: OperatorSupplierOptions["balanceService"];

  constructor(options: OperatorSupplierOptions) {
    this.notifyOperator = options.notifyOperator;
    this.logger = options.logger;
    this.starvellRead = options.starvellRead;
    this.balanceService = options.balanceService;
  }

  async purchase(request: SupplierPurchaseRequest): Promise<SupplierPurchaseResponse> {
    const taskId = crypto.randomUUID();
    const orderId = (request as any).__orderId as string | undefined;
    if (!orderId) {
      throw new Error("Operator supplier requires orderId in request");
    }

    const quoteTask = await prisma.supplierTask.findFirst({
      where: { orderId, quotedCostRub: { not: null } },
      orderBy: { updatedAt: "desc" },
    });
    const quotedCost = quoteTask?.quotedCostRub ?? null;

    let insufficientMessage: string | null = null;
    let insufficientBalance = 0;
    let insufficientCost = 0;
    let estimatedCost: number | null = null;
    if (this.balanceService) {
      const offerInfo = this.starvellRead ? await this.starvellRead.getOfferByUrl(request.offer_url) : null;
      let balance;
      try {
        balance = await this.balanceService.getBalance(true);
      } catch (err) {
        this.logger.warn({ err }, "BALANCE_FETCH_FAILED");
      }
      if (offerInfo?.pricePerUnit && balance) {
        const baseCost = offerInfo.pricePerUnit * request.amount_robux;
        estimatedCost = baseCost;
        const cost = quotedCost ?? baseCost;
        const available = balance.available ?? 0;
        if (available < cost) {
          insufficientBalance = available;
          insufficientCost = cost;
          const label = quotedCost ? "стоимость" : "оценка";
          insufficientMessage = `❌ Недостаточно средств на Starvell: баланс ${available.toFixed(2)}₽, ${label} ${cost.toFixed(2)}₽.`;
          this.logger.warn(
            `Insufficient funds balance=${available} cost=${cost.toFixed(2)} qty=${request.amount_robux} offer=${request.offer_url} task=${taskId}`
          );
        } else {
          this.logger.info(
            `STARVELL_FUNDS_OK available=${available} cost=${cost.toFixed(2)} qty=${request.amount_robux} offer=${request.offer_url}`
          );
        }
      } else if (!offerInfo?.pricePerUnit) {
        this.logger.warn("STARVELL_PRICE_UNKNOWN");
        if (balance) {
          this.logger.info(`STARVELL_FUNDS_OK available=${balance.available} cost=unknown qty=${request.amount_robux}`);
        }
      }
    } else if (this.starvellRead?.isEnabled()) {
      const offerInfo = await this.starvellRead.getOfferByUrl(request.offer_url);
      let profile;
      try {
        profile = await this.starvellRead.getProfile();
      } catch (err) {
        this.logger.warn({ err }, "STARVELL_BALANCE_FETCH_FAILED");
      }
      if (offerInfo?.pricePerUnit && profile) {
        const baseCost = offerInfo.pricePerUnit * request.amount_robux;
        estimatedCost = baseCost;
        const cost = quotedCost ?? baseCost;
        const available = profile.available ?? 0;
        if (available < cost) {
          insufficientBalance = available;
          insufficientCost = cost;
          const label = quotedCost ? "стоимость" : "оценка";
          insufficientMessage = `❌ Недостаточно средств на Starvell: доступно ${available.toFixed(2)}₽, ${label} ${cost.toFixed(2)}₽. Пополните кошелёк или уменьшите qty.`;
          this.logger.warn(
            `Insufficient funds balance=${available} cost=${cost.toFixed(2)} qty=${request.amount_robux} offer=${request.offer_url} task=${taskId}`
          );
        } else {
          this.logger.info(
            `STARVELL_FUNDS_OK available=${available} cost=${cost.toFixed(2)} qty=${request.amount_robux} offer=${request.offer_url}`
          );
        }
      } else if (!offerInfo?.pricePerUnit) {
        this.logger.warn("STARVELL_PRICE_UNKNOWN");
      }
    }

    const order = await prisma.order.findUnique({ where: { id: orderId } });

    if (insufficientMessage) {
      await prisma.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.WAIT_TOPUP, statusDetails: "INSUFFICIENT_FUNDS" },
      });

      const task = await prisma.supplierTask.create({
        data: {
          id: taskId,
          orderId,
          dealId: order?.dealId ?? null,
          supplierOfferUrl: request.offer_url,
          quantity: request.amount_robux,
          robloxUsername: request.roblox_username,
          gamepassUrl: request.gamepass_url,
          gamepassId: (request as any).gamepass_id ?? null,
          status: "WAIT_TOPUP",
          failReason: "INSUFFICIENT_FUNDS",
          quotedCostRub: quotedCost,
        },
      });

      const lines = [
        "🧾 Операторская покупка (недостаточно средств)",
        `taskId: ${task.id}`,
        order?.dealId ? `dealId: ${order.dealId}` : null,
        `offer: ${task.supplierOfferUrl}`,
        `open: ${task.supplierOfferUrl}`,
        `qty: ${task.quantity}`,
        `nick: ${task.robloxUsername}`,
        `copy: nick: ${task.robloxUsername} | qty: ${task.quantity}`,
        `gamepass: ${task.gamepassUrl}`,
        `gamepassId: ${task.gamepassId ?? "-"}`,
        estimatedCost ? `estimatedCost: ${estimatedCost.toFixed(2)}₽` : null,
        quotedCost ? `quotedCost: ${quotedCost.toFixed(2)}₽` : null,
        "",
        "💸 Указать точную стоимость:",
        `!supplier quote ${task.id} <costRUB>`,
        "",
        "🔁 После пополнения/уточнения:",
        `!supplier retry ${task.id}`,
        "",
        "✅ Подтвердить (когда поставщик написал “купил/жду подтверждение”):",
        `!supplier done ${task.id}`,
        "",
        "❌ Ошибка:",
        `!supplier fail ${task.id} <причина>`,
        "",
        "ℹ️ Статус:",
        `!supplier status ${task.id}`,
      ];
      const message = lines.filter(Boolean).join("\n");

      try {
        await this.notifyOperator(message);
        await this.notifyOperator(insufficientMessage);
        this.logger.info({ ok: true, taskId, balance: insufficientBalance, cost: insufficientCost }, "operator_notify insufficient_funds sent");
      } catch (err) {
        this.logger.error({ err }, "Failed to notify operator about insufficient funds");
        this.logger.info({ ok: false, taskId }, "operator_notify insufficient_funds sent");
      }
      throw new InsufficientFundsError(insufficientBalance, insufficientCost);
    }

    const task = await prisma.supplierTask.create({
      data: {
        id: taskId,
        orderId,
        dealId: order?.dealId ?? null,
        supplierOfferUrl: request.offer_url,
        quantity: request.amount_robux,
        robloxUsername: request.roblox_username,
        gamepassUrl: request.gamepass_url,
        gamepassId: (request as any).gamepass_id ?? null,
        status: "PENDING",
        quotedCostRub: quotedCost,
      },
    });
    const lines = [
      "🧾 Операторская покупка",
      `taskId: ${task.id}`,
      order?.dealId ? `dealId: ${order.dealId}` : null,
        `offer: ${task.supplierOfferUrl}`,
        `open: ${task.supplierOfferUrl}`,
        `qty: ${task.quantity}`,
        `nick: ${task.robloxUsername}`,
        `copy: nick: ${task.robloxUsername} | qty: ${task.quantity}`,
        `gamepass: ${task.gamepassUrl}`,
        `gamepassId: ${task.gamepassId ?? "-"}`,
      estimatedCost ? `estimatedCost: ${estimatedCost.toFixed(2)}₽` : null,
      quotedCost ? `quotedCost: ${quotedCost.toFixed(2)}₽` : null,
      "",
      "🛒 После покупки на Starvell:",
      `!supplier bought ${task.id} <orderId_or_url>`,
      "",
      "✅ Подтвердить (когда поставщик написал “купил/жду подтверждение”):",
      `!supplier done ${task.id}`,
      "",
      "❌ Ошибка:",
      `!supplier fail ${task.id} <причина>`,
      "",
      "ℹ️ Статус:",
      `!supplier status ${task.id}`,
    ];
    const message = lines.filter(Boolean).join("\n");

    try {
      await this.notifyOperator(message);
    } catch (err) {
      this.logger.error({ err }, "Failed to notify operator");
    }

    return { supplier_order_id: taskId };
  }

  async status(supplierOrderId: string): Promise<SupplierStatusResponse> {
    const task = await prisma.supplierTask.findUnique({ where: { id: supplierOrderId } });
    if (!task) {
      return { status: "FAILED", details: "Operator task not found" };
    }
    if (task.status === "DONE") {
      return { status: "DONE", details: task.proof ?? "operator_done" };
    }
    if (task.status === "FAILED") {
      return { status: "FAILED", details: task.failReason ?? "operator_failed" };
    }
    return { status: "PENDING" };
  }
}
