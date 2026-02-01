import "dotenv/config";
import { loadEnv, loadProductConfig } from "./config";
import { createLogger } from "./logger";
import { prisma } from "./db/client";
import { ensureDatabaseReady } from "./db/migrate";
import { InProcessQueue } from "./worker/queue";
import { startNoSuppliersSweeper } from "./worker/noSuppliersSweeper";
import { startAdminServer } from "./admin/server";
import { handleDealEvent, handleMessageEvent } from "./playerok/handlers";
import { OrderStatus } from "./orders/fsm";
import { createPlayerokClient } from "./playerok/sdk";
import { startPlayerokWebhook } from "./playerok/webhook";
import { completeDealViaProxy, sendMessageViaProxy } from "./playerok/proxy";
import { StarvellChatMonitor } from "./starvell/monitor";
import { StarvellReadClient } from "./starvell/readClient";
import { TelegramBot } from "./telegram/telegramBot";
import { SupplierBalanceService } from "./supplier/balance";
import { fetchStarvellFunds } from "./supplier/starvellWallet";
import { SupplierPool, loadSuppliersConfig } from "./suppliers/pool";

async function main() {
  const env = loadEnv();
  const productConfig = loadProductConfig();
  const logger = createLogger(env.logLevel);

  await ensureDatabaseReady(logger);

  const client = createPlayerokClient(env.playerokToken, logger);

  const notifyBuyer = async (chatId: string, message: string) => {
    try {
      if (typeof client.sendMessage === "function") {
        await client.sendMessage(chatId, message);
        if (client.isStub) {
          logger.warn("notifyBuyer used stub client; no real message was sent");
          if (env.playerokProxyUrl) {
            await sendMessageViaProxy(env.playerokProxyUrl, env.playerokProxyToken, chatId, message, logger);
            logger.info("notifyBuyer sent via Python proxy");
          }
        }
        return;
      }
      if (typeof client.sendMessageToChat === "function") {
        await client.sendMessageToChat(chatId, message);
        return;
      }
      logger.warn("Playerok client has no sendMessage method");
    } catch (err) {
      logger.error({ err }, "Failed to send Playerok message");
    }
  };

  const starvellRead = env.starvellCookie ? new StarvellReadClient(env.starvellCookie, logger) : undefined;
  const balanceService = new SupplierBalanceService({
    supplierBaseUrl: env.supplierBaseUrl,
    starvellRead,
    logger,
  });

  const supplierConfig = loadSuppliersConfig();
  const supplierPool = new SupplierPool(supplierConfig, logger);
  try {
    // @ts-ignore
    const row = await prisma.settings.findUnique({ where: { key: "suppliersConfig" } });
    if (row?.value) {
      const cfg = JSON.parse(row.value);
      supplierPool.applyConfig(cfg);
      logger.info("Applied suppliersConfig from Settings");
    }
  } catch (err) {
    logger.warn({ err }, "Settings table not available; using file config");
  }

  const starvellMonitor =
    env.supplierMode === "operator" && env.starvellCookie
      ? new StarvellChatMonitor({ cookie: env.starvellCookie, logger, notifyBuyer })
      : undefined;

  let telegramBot: TelegramBot | undefined;
  let operatorChatId = env.telegramOperatorChatId;
  if (!operatorChatId) {
    const stored = await prisma.operatorConfig.findUnique({ where: { id: "telegram" } });
    if (stored?.telegramChatId) {
      operatorChatId = stored.telegramChatId;
    }
  }
  if (env.supplierMode === "operator") {
    if (env.telegramBotToken) {
      telegramBot = new TelegramBot({ token: env.telegramBotToken, operatorChatId, logger });
      logger.info("Telegram operator bot enabled");
      if (!operatorChatId) {
        logger.warn("TELEGRAM_OPERATOR_CHAT_ID missing; use /chatid in Telegram to get it");
      }
    } else {
      logger.warn("Telegram operator bot disabled: TELEGRAM_BOT_TOKEN missing");
    }
  }

  const queue = new InProcessQueue({
    logger,
    notifyBuyer,
    completeDeal: async (dealId: string) => {
      try {
        if (typeof client.completeDeal === "function") {
          await client.completeDeal(dealId);
          if (client.isStub) {
            logger.warn("completeDeal used stub client; TODO: enable JS SDK to confirm deal in Playerok");
            if (env.playerokProxyUrl) {
              await completeDealViaProxy(env.playerokProxyUrl, env.playerokProxyToken, dealId, logger);
              logger.info("completeDeal sent via Python proxy");
            }
          }
          return;
        }
        if (typeof client.confirmDeal === "function") {
          await client.confirmDeal(dealId);
          return;
        }
        logger.warn("Playerok client has no completeDeal method");
      } catch (err) {
        logger.error({ err }, "Failed to complete Playerok deal");
      }
    },
    notifyOperator: telegramBot ? (message) => telegramBot!.sendToOperator(message) : undefined,
    supplierPool,
  });

  startAdminServer({
    prisma,
    pool: {
      getSnapshot: () => supplierPool.getSnapshot(),
      forceRefresh: (id?: string) => supplierPool.forceRefresh(id, 100),
      applyConfig: (cfg: any) => supplierPool.applyConfig(cfg),
    },
    port: Number(process.env.ADMIN_PORT || 3001),
  });

  const handleDeal = async (payload: any) => {
    await handleDealEvent(payload, {
      queue,
      logger,
      productConfig,
      defaultOfferUrl: env.defaultOfferUrl,
      notifyBuyer,
    });
  };

  const handleMessage = async (payload: any) => {
    await handleMessageEvent(payload, {
      queue,
      logger,
      productConfig,
      defaultOfferUrl: env.defaultOfferUrl,
      notifyBuyer,
      starvellMonitor,
    });
  };

  if (telegramBot) {
    telegramBot.startPolling(async (cmdText, chatId) => {
      await handleTelegramCommand(cmdText, chatId, telegramBot, logger, starvellMonitor, balanceService, queue);
    });
    logger.info("Telegram polling started");
  }

  client.onNewDeal(handleDeal);
  client.onItemPaid(handleDeal);
  client.onNewMessage(handleMessage);

  startPlayerokWebhook({
    logger,
    port: env.playerokWebhookPort,
    path: env.playerokWebhookPath,
    token: env.playerokWebhookToken || undefined,
    onEvent: async (eventType, payload) => {
      switch (eventType) {
        case "NEW_DEAL":
        case "ITEM_PAID":
          await handleDeal(payload);
          break;
        case "NEW_MESSAGE": {
          const msgPayload = payload as { deal_id?: string; amount_robux?: number };
          if (msgPayload?.deal_id && msgPayload?.amount_robux) {
            await handleDeal(msgPayload);
          }
          await handleMessage(payload);
          break;
        }
        default:
          logger.warn(`Unhandled webhook event: ${eventType}`);
      }
    },
  });

  const pendingOrders = await prisma.order.findMany({
    where: {
      status: {
        in: [
          OrderStatus.READY_TO_BUY,
          OrderStatus.SUPPLIER_PENDING,
          OrderStatus.WAIT_TOPUP,
          OrderStatus.SUPPLIER_ERROR,
        ],
      },
    },
  });

  for (const order of pendingOrders) {
    if (order.status === OrderStatus.READY_TO_BUY) {
      queue.enqueuePurchase(order.id);
    }
    if (order.status === OrderStatus.SUPPLIER_ERROR) {
      queue.enqueuePurchase(order.id);
    }
  }

  startNoSuppliersSweeper({
    prisma,
    queue,
    logger,
    intervalMs: 60_000,
  });

  logger.info("Playerok Starvell bot started");
}

async function handleTelegramCommand(
  text: string,
  chatId: string,
  telegram: TelegramBot,
  logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void },
  starvellMonitor?: { start: (taskId: string) => void },
  balanceService?: SupplierBalanceService,
  queue?: InProcessQueue
) {
  const trimmed = text.trim();
  if (trimmed === "/chatid") {
    await telegram.sendMessage(chatId, `chat_id: ${chatId}`);
    await prisma.operatorConfig.upsert({
      where: { id: "telegram" },
      update: { telegramChatId: chatId },
      create: { id: "telegram", telegramChatId: chatId },
    });
    telegram.setOperatorChatId(chatId);
    return;
  }

  const operatorChatId = telegram.getOperatorChatId();
  if (operatorChatId && operatorChatId !== chatId) {
    return;
  }

  const reply = async (message: string) => {
    if (operatorChatId) {
      await telegram.sendToOperator(message);
    } else {
      await telegram.sendMessage(chatId, message);
    }
  };

  if (
    !trimmed.startsWith("!supplier") &&
    !trimmed.startsWith("/balance") &&
    trimmed !== "/suppliers" &&
    trimmed !== "!suppliers"
  )
    return;
  const parts = trimmed.split(/\s+/);
  if (trimmed.startsWith("/balance")) {
    if (!balanceService) {
      await reply("Баланс недоступен: сервис не настроен.");
      return;
    }
    const args = parts.slice(1);
    if (args.length < 3) {
      await reply("Использование: /balance <available> <pending> <frozen> или /balance available=... pending=... frozen=...");
      return;
    }
    let available: number | undefined;
    let pending: number | undefined;
    let frozen: number | undefined;
    if (args.some((a) => a.includes("="))) {
      for (const arg of args) {
        const [key, value] = arg.split("=");
        const num = Number.parseFloat((value ?? "").replace(",", "."));
        if (!Number.isFinite(num)) continue;
        if (key === "available") available = num;
        if (key === "pending") pending = num;
        if (key === "frozen") frozen = num;
      }
    } else {
      available = Number.parseFloat(args[0].replace(",", "."));
      pending = Number.parseFloat(args[1].replace(",", "."));
      frozen = Number.parseFloat(args[2].replace(",", "."));
    }
    if (![available, pending, frozen].every((n) => Number.isFinite(n))) {
      await reply("Нужны числа. Пример: /balance 2545.4 0 0");
      return;
    }
    await balanceService.setManualBalance(available!, pending!, frozen!);
    await reply("Manual balance saved (source=manual).");
    return;
  }
  const action = trimmed === "/suppliers" || trimmed === "!suppliers" ? "suppliers" : parts[1]?.toLowerCase();
  const subcommand = parts[2]?.toLowerCase();
  const taskId = parts[2];
  const rest = parts.slice(3).join(" ").trim();

  if (
    !action ||
    (action !== "done" &&
      action !== "fail" &&
      action !== "status" &&
      action !== "bought" &&
      action !== "quote" &&
      action !== "retry" &&
      action !== "pending" &&
      action !== "suppliers" &&
      action !== "failed" &&
      action !== "help" &&
      action !== "funds" &&
      action !== "balance" &&
      action !== "reset")
  ) {
    await reply(
      "Использование:\n!supplier bought <taskId> <orderRef>\n!supplier quote <taskId> <costRUB>\n!supplier retry <taskId>\n!supplier done <taskId>\n!supplier fail <taskId> <reason>\n!supplier status <taskId>\n!supplier pending\n!supplier done\n!supplier failed\n!supplier funds\n!supplier suppliers\n!supplier reset <orderId>\n/balance available pending frozen\n!supplier help"
    );
    return;
  }

  if (action === "help") {
    await reply(
      "Команды:\n!supplier bought <taskId> <orderRef>\n!supplier quote <taskId> <costRUB>\n!supplier retry <taskId>\n!supplier done <taskId>\n!supplier fail <taskId> <reason>\n!supplier status <taskId>\n!supplier pending\n!supplier done\n!supplier failed\n!supplier funds\n!supplier suppliers\n!supplier reset <orderId>\n/balance available pending frozen"
    );
    return;
  }


  if (action === "funds") {
    if (!balanceService) {
      await reply("Баланс недоступен: сервис не настроен.");
      return;
    }
    try {
      try {
        const b = await fetchStarvellFunds();
        await reply(
          `available: ${formatRub(b.available)}\npending: ${formatRub(b.pending)}\nfrozen: ${formatRub(
            b.frozen
          )}\nsource: playwright_wallet\nupdated: ${new Date().toISOString()}`
        );
        return;
      } catch (err) {
        logger.warn({ err }, "STARVELL_WALLET_PLAYWRIGHT_FAILED");
      }

      const balance = await balanceService.getBalance(true);
      await reply(
        `available: ${formatRub(balance.available)}\npending: ${formatRub(balance.pending)}\nfrozen: ${formatRub(
          balance.frozen
        )}\nsource: ${balance.source}\nupdated: ${balance.updatedAt.toISOString()}`
      );
    } catch (err: any) {
      logger.error({ err }, "SUPPLIER_FUNDS_ERROR");
      await reply("Не удалось получить баланс автоматически. Можно задать вручную: /balance available pending frozen");
    }
    return;
  }

  if (action === "suppliers") {
    if (!queue) {
      await reply("Пул поставщиков не настроен.");
      return;
    }
    if (subcommand === "refresh") {
      const target = parts[3];
      try {
        await queue.forceRefreshSuppliers(target, 100);
        await reply(target ? `OK: refresh ${target}` : "OK: refresh all suppliers");
      } catch (err: any) {
        await reply(`Ошибка refresh: ${err?.message ?? err}`);
      }
      return;
    }
    if (subcommand === "reset") {
      const orderId = parts[3];
      if (!orderId) {
        await reply("Нужен orderId. Пример: /suppliers reset <orderId>");
        return;
      }
      const order = await prisma.order.findUnique({ where: { id: orderId } });
      if (!order) {
        await reply(`Заказ не найден: ${orderId}`);
        return;
      }
      let details: any = {};
      try {
        details = order.statusDetails ? JSON.parse(order.statusDetails) : {};
      } catch {
        details = {};
      }
      if (details.noSuppliers) {
        details.noSuppliers = { attempt: 0, nextRetryAt: 0, firstAt: 0 };
      } else {
        details.noSuppliersRetryCount = 0;
        details.noSuppliersNextRetryAt = 0;
        details.noSuppliersFirstAt = 0;
      }
      await prisma.order.update({
        where: { id: orderId },
        data: {
          status: OrderStatus.READY_TO_BUY,
          statusDetails: JSON.stringify(details),
          lastErrorCode: null,
          lastErrorMessage: null,
          nextAction: null,
        },
      });
      queue.enqueuePurchase(orderId);
      await reply(`OK: reset ${orderId} и перезапуск`);
      return;
    }

    const snapshot = queue.getSupplierSnapshot();
    if (!snapshot) {
      await reply("Пул поставщиков недоступен.");
      return;
    }
    const header =
      `maxConcurrency=${snapshot.maxConcurrency} active=${snapshot.active} ` +
      `maxUnitPriceRub=${snapshot.maxUnitPriceRub} ` +
      `refreshPriceMs=${snapshot.refreshPriceMs}`;
    const lines = snapshot.suppliers.map(
      (s: any) =>
        `${s.id} | ${s.status} | price=${s.unitPriceRub ?? "-"} | required=${s.requiredRub ?? "-"} | q=${s.queueSize} | ${s.offerUrl}\n  reason: ${s.reason}`
    );
    await reply([header, ...lines].join("\n"));
    return;
  }

  if (action === "reset") {
    if (!queue) {
      await reply("Очередь не настроена.");
      return;
    }
    const orderId = parts[2];
    if (!orderId) {
      await reply("Нужен orderId. Пример: !supplier reset <orderId>");
      return;
    }
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      await reply(`Заказ не найден: ${orderId}`);
      return;
    }
    let details: any = {};
    try {
      details = order.statusDetails ? JSON.parse(order.statusDetails) : {};
    } catch {
      details = {};
    }
    if (details.noSuppliers) {
      details.noSuppliers = { attempt: 0, nextRetryAt: 0, firstAt: 0 };
    } else {
      details.noSuppliersRetryCount = 0;
      details.noSuppliersNextRetryAt = 0;
      details.noSuppliersFirstAt = 0;
    }
    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.READY_TO_BUY,
        statusDetails: JSON.stringify(details),
        lastErrorCode: null,
        lastErrorMessage: null,
        nextAction: null,
      },
    });
    queue.enqueuePurchase(orderId);
    await reply(`OK: reset ${orderId} и перезапуск`);
    return;
  }

  if (!taskId) {
    if (action === "pending" || action === "done" || action === "failed") {
      const whereStatus =
        action === "pending"
          ? { status: { notIn: ["DONE", "FAILED"] } }
          : action === "done"
          ? { status: "DONE" }
          : { status: "FAILED" };
      const tasks = await prisma.supplierTask.findMany({
        where: whereStatus,
        orderBy: { updatedAt: "desc" },
        take: 10,
      });
      if (!tasks.length) {
        await reply("Нет задач.");
        return;
      }
      const lines = tasks.map(
        (t) =>
          `${t.id} | dealId=${t.dealId ?? "-"} | qty=${t.quantity} | nick=${t.robloxUsername} | status=${t.status} | updated=${t.updatedAt.toISOString()}${
            t.failReason ? ` | err=${t.failReason}` : ""
          }`
      );
      await reply(lines.join("\n"));
      return;
    }
    await reply("Нужен taskId. Пример: !supplier status <taskId>");
    return;
  }

  const task = await prisma.supplierTask.findUnique({ where: { id: taskId } });
  if (!task) {
    await reply(`Задача не найдена: ${taskId}`);
    return;
  }

  if (action === "status") {
    const order = await prisma.order.findUnique({ where: { id: task.orderId } });
    const lines = [
      `taskId: ${task.id}`,
      `status: ${task.status}`,
      `dealId: ${task.dealId ?? "-"}`,
      `offer: ${task.supplierOfferUrl}`,
      `qty: ${task.quantity}`,
      `nick: ${task.robloxUsername}`,
      `gamepass: ${task.gamepassUrl}`,
      `gamepassId: ${task.gamepassId ?? "-"}`,
      `quotedCost: ${task.quotedCostRub ?? "-"}`,
      `starvellOrderRef: ${task.starvellOrderRef ?? "-"}`,
      `lastError: ${order?.lastErrorMessage ?? "-"}`,
      `updatedAt: ${task.updatedAt.toISOString()}`,
    ];
    await reply(lines.join("\n"));
    return;
  }

  if (action === "bought") {
    if (!rest) {
      await reply("Нужен orderRef. Пример: !supplier bought <taskId> https://starvell.com/order/XXXX");
      return;
    }
    if (task.status === "DONE" || task.status === "FAILED") {
      await reply(`Нельзя привязать покупку, задача уже ${task.status}.`);
      return;
    }
    await prisma.supplierTask.update({
      where: { id: taskId },
      data: { status: "WAIT_SUPPLIER_CONFIRM", starvellOrderId: extractStarvellOrderId(rest), starvellOrderRef: rest },
    });
    await reply(`OK: привязал orderRef, жду подтверждение поставщика.`);
    return;
  }

  if (action === "quote") {
    const costRaw = rest.split(/\s+/)[0];
    const cost = Number.parseFloat((costRaw ?? "").replace(",", "."));
    if (!Number.isFinite(cost)) {
      await reply("Нужна стоимость числом. Пример: !supplier quote <taskId> 47.56");
      return;
    }
    await prisma.supplierTask.update({
      where: { id: taskId },
      data: { quotedCostRub: cost },
    });
    await prisma.order.update({
      where: { id: task.orderId },
      data: { statusDetails: "QUOTE_SET" },
    });
    if (balanceService) {
      try {
        const balance = await balanceService.getBalance(true);
        if (balance.available >= cost) {
          await prisma.order.update({
            where: { id: task.orderId },
            data: { status: OrderStatus.READY_TO_BUY, statusDetails: "QUOTE_OK", nextAction: null },
          });
          if (queue) {
            queue.enqueuePurchase(task.orderId);
          }
          await reply(`OK: quote ${cost.toFixed(2)}₽ сохранён, средств достаточно. Заказ перезапущен.`);
          return;
        }
        await prisma.order.update({
          where: { id: task.orderId },
          data: { status: OrderStatus.WAIT_TOPUP, statusDetails: "INSUFFICIENT_FUNDS" },
        });
        await reply(`OK: quote ${cost.toFixed(2)}₽ сохранён, но средств недостаточно.`);
        return;
      } catch (err) {
        logger.warn({ err }, "QUOTE_BALANCE_CHECK_FAILED");
      }
    }
    await reply(`OK: quote ${cost.toFixed(2)}₽ сохранён.`);
    return;
  }

  if (action === "retry") {
    if (!queue) {
      await reply("Очередь не настроена, retry невозможен.");
      return;
    }
    await prisma.supplierTask.update({
      where: { id: taskId },
      data: { status: "PENDING", failReason: null },
    });
    await prisma.order.update({
      where: { id: task.orderId },
      data: {
        status: OrderStatus.READY_TO_BUY,
        statusDetails: "RETRY",
        lastErrorCode: null,
        lastErrorMessage: null,
        nextAction: null,
        retryCount: { increment: 1 },
      },
    });
    queue.enqueuePurchase(task.orderId);
    await reply(`OK: retry запущен для ${taskId}`);
    return;
  }

  if (action === "done") {
    if (task.status === "DONE" || task.status === "FAILED") {
      await reply(`Нельзя завершить, задача уже ${task.status}.`);
      return;
    }
    if (task.status !== "WAIT_SUPPLIER_CONFIRM" || !task.starvellOrderRef) {
      await reply("Нельзя завершить: сначала !supplier bought <taskId> <orderRef>.");
      return;
    }
    await prisma.supplierTask.update({
      where: { id: taskId },
      data: { status: "DONE", proof: rest || "done" },
    });
    await reply(`✅ DONE: ${taskId}`);
    return;
  }

  if (task.status === "DONE" || task.status === "FAILED") {
    await reply(`Нельзя изменить, задача уже ${task.status}.`);
    return;
  }

  if (!rest) {
    await reply("Нужна причина. Пример: !supplier fail <taskId> <причина>");
    return;
  }

  await prisma.supplierTask.update({
    where: { id: taskId },
    data: { status: "FAILED", failReason: rest },
  });
  await reply(`❌ FAILED: ${taskId} reason=${rest}`);
}

function formatRub(value: number | undefined) {
  const num = value ?? 0;
  return `${num.toFixed(2)}₽`;
}

function extractStarvellOrderId(value: string): string | null {
  if (!value) return null;
  const match = value.match(/order\/([0-9a-f\-]{6,})/i);
  if (match?.[1]) return match[1];
  const direct = value.trim();
  if (/^[0-9a-f\-]{6,}$/i.test(direct)) return direct;
  return null;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
