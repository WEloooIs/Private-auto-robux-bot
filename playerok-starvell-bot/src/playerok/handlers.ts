import { prisma } from "../db/client";
import { OrderStatus } from "../orders/fsm";
import { resolveOfferUrl, resolveRobuxAmount, type ProductConfig } from "../config";
import type { InProcessQueue } from "../worker/queue";

const usernameRegex = /^(?!.*\s)(.{3,20})$/;
const urlRegex = /(https?:\/\/[^\s]+)/gi;
const gamepassIdRegex = /\b(?:id|ID|пасса|gamepass|game\s*pass)\s*[:#-]?\s*(\d{4,20})\b/i;
const digitsRegex = /\b\d{4,20}\b/;
const debounceMs = 7000;
const lastReplyAt = new Map<string, number>();

export interface DealEventPayload {
  deal_id?: string;
  chat_id?: string;
  amount_robux?: number;
  offer_url?: string;
  product_id?: string;
  item_name?: string;
}

export interface MessageEventPayload {
  deal_id?: string;
  chat_id?: string;
  text?: string;
  message?: string;
  from_buyer?: boolean;
}

export interface HandlerDeps {
  queue: InProcessQueue;
  logger: { info: (...args: any[]) => void; error: (...args: any[]) => void; warn: (...args: any[]) => void };
  productConfig: ProductConfig;
  defaultOfferUrl: string;
  notifyBuyer: (chatId: string, message: string) => Promise<void>;
  starvellMonitor?: { start: (taskId: string) => void };
}

function extractUsername(text: string): string | null {
  const trimmed = text.trim();
  const normalized = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (usernameRegex.test(normalized)) return normalized;

  const match = trimmed.match(/ник\s*[:\-]\s*@?(\S{3,20})/i);
  if (match && usernameRegex.test(match[1])) return match[1];
  return null;
}

function extractGamepassUrl(text: string): string | null {
  const matches = [...text.matchAll(urlRegex)].map((m) => m[0]);
  if (!matches.length) return null;
  const prioritized = matches.find((m) => /\/passes\/\d+/i.test(m) || /\/game-pass\/\d+/i.test(m));
  const candidate = prioritized ?? matches[0];
  try {
    const url = new URL(candidate);
    return url.toString();
  } catch {
    return null;
  }
}

function extractGamepassId(text: string, url: string | null): string | null {
  let urlMatched = false;
  if (url) {
    try {
      const parsed = new URL(url);
      const passMatch = parsed.pathname.match(/passes\/(\d{4,20})/i);
      if (passMatch?.[1]) return passMatch[1];
      const match = parsed.pathname.match(/game-pass\/(\d{4,20})/i);
      if (match?.[1]) return match[1];
      urlMatched = true;
    } catch {
      // ignore URL parse errors
    }
  }

  const labeled = text.match(gamepassIdRegex);
  if (labeled?.[1]) return labeled[1];

  if (urlMatched) return null;
  const loose = text.match(digitsRegex);
  if (loose?.[0]) return loose[0];
  return null;
}

function logStatusChange(logger: HandlerDeps["logger"], dealId: string, from: string, to: string) {
  if (from === to) return;
  logger.info(`Order status ${dealId}: ${from} -> ${to}`);
}

export async function handleDealEvent(payload: DealEventPayload, deps: HandlerDeps) {
  const dealId = payload.deal_id?.toString();
  const chatId = payload.chat_id?.toString();
  const amountRobux = resolveRobuxAmount(payload.amount_robux, payload.product_id, payload.item_name, deps.productConfig);
  if (!dealId || !chatId || amountRobux <= 0) {
    deps.logger.info(
      { dealId, chatId, amountRobux, itemName: payload.item_name ?? null },
      "Ignoring non-robux deal payload"
    );
    return;
  }

  const offerUrl = resolveOfferUrl(payload.offer_url, payload.product_id, deps.productConfig, deps.defaultOfferUrl);

  const existing = await prisma.order.findUnique({ where: { dealId } });
  if (existing) return;

  const order = await prisma.order.create({
    data: {
      dealId,
      chatId,
      productId: payload.product_id ?? null,
      amountRobux,
      offerUrl,
      status: OrderStatus.PAID_RECEIVED,
    },
  });
  deps.logger.info(`Order created deal_id=${dealId} status=${OrderStatus.PAID_RECEIVED}`);

  if (!order.robloxUsername) {
    logStatusChange(deps.logger, dealId, order.status, OrderStatus.WAIT_USERNAME);
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.WAIT_USERNAME } });
    await deps.notifyBuyer(order.chatId, "Пришлите ник Roblox (одним сообщением).");
    return;
  }

  if (!order.gamepassUrl) {
    logStatusChange(deps.logger, dealId, order.status, OrderStatus.WAIT_GAMEPASS_URL);
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.WAIT_GAMEPASS_URL } });
    await deps.notifyBuyer(
      order.chatId,
      "Пришлите ссылку на ваш геймпасс и ID пасса (числом). Плейс должен быть публичным. Не забудьте отключить Regional Pricing."
    );
    return;
  }

  if (!order.gamepassId) {
    logStatusChange(deps.logger, dealId, order.status, OrderStatus.WAIT_GAMEPASS_ID);
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.WAIT_GAMEPASS_ID } });
    await deps.notifyBuyer(order.chatId, "Пришлите ID геймпасса (числом).");
    return;
  }

  logStatusChange(deps.logger, dealId, order.status, OrderStatus.READY_TO_BUY);
  await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.READY_TO_BUY } });
  const ahead = deps.queue.size();
  await deps.notifyBuyer(order.chatId, `Заявка принята. Перед вами в очереди: ${ahead}`);
  deps.queue.enqueuePurchase(order.id);
}

export async function handleMessageEvent(payload: MessageEventPayload, deps: HandlerDeps) {
  const chatId = payload.chat_id?.toString();
  const dealId = payload.deal_id?.toString();
  const text = (payload as any)?.text ?? (payload as any)?.message ?? (payload as any)?.data?.text ?? "";
  if (!chatId) return;
  if (!text) {
    deps.logger.warn({ dealId, chatId }, "NEW_MESSAGE without text");
    await deps.notifyBuyer(chatId, "Не вижу текст сообщения, повторите, пожалуйста.");
    return;
  }

  deps.logger.info(
    {
      dealId,
      chatId,
      textLength: text.length,
      textPreview: text.slice(0, 50),
    },
    "NEW_MESSAGE received"
  );

  const order = dealId
    ? await prisma.order.findUnique({ where: { dealId } })
    : await prisma.order.findFirst({
        where: { chatId },
        orderBy: { updatedAt: "desc" },
      });

  if (!order) {
    deps.logger.warn({ dealId, chatId }, "Order not found for deal_id");
    const latest = await prisma.order.findFirst({
      where: { chatId },
      orderBy: { updatedAt: "desc" },
    });
    if (latest?.status === OrderStatus.SUPPLIER_PENDING) {
      await deps.notifyBuyer(chatId, "Заказ в работе у поставщика. Ожидайте сообщения о выполнении.");
    }
    return;
  }

  deps.logger.info(
    { dealId: order.dealId, status: order.status, textLength: text.length, textPreview: text.slice(0, 50) },
    "NEW_MESSAGE matched order"
  );

  if (order.status === OrderStatus.SUPPLIER_PENDING) {
    await deps.notifyBuyer(chatId, "Заказ в работе у поставщика. Ожидайте сообщения о выполнении.");
    return;
  }
  if (order.status === OrderStatus.DONE) {
    await deps.notifyBuyer(chatId, "Заказ уже выполнен ✅");
    return;
  }
  const wasFailed = order.status === OrderStatus.FAILED;

  const username = extractUsername(text);
  const gamepassUrl = extractGamepassUrl(text);
  const gamepassId = extractGamepassId(text, gamepassUrl);

  const updates: { robloxUsername?: string; gamepassUrl?: string; gamepassId?: string; status?: string } = {};

  if (username && !order.robloxUsername) {
    updates.robloxUsername = username;
  }
  if (gamepassUrl && !order.gamepassUrl) {
    updates.gamepassUrl = gamepassUrl;
  }
  if (gamepassId && !order.gamepassId) {
    updates.gamepassId = gamepassId;
  }

  const currentStatus = order.status === "WAIT_GAMEPASS" ? OrderStatus.WAIT_GAMEPASS_URL : order.status;
  let nextStatus = currentStatus;
  if (
    (updates.robloxUsername ?? order.robloxUsername) &&
    (updates.gamepassUrl ?? order.gamepassUrl) &&
    (updates.gamepassId ?? order.gamepassId)
  ) {
    nextStatus = OrderStatus.READY_TO_BUY;
    updates.status = nextStatus;
  } else if (!order.robloxUsername && updates.robloxUsername) {
    nextStatus = OrderStatus.WAIT_GAMEPASS_URL;
    updates.status = nextStatus;
  } else if ((updates.gamepassUrl ?? order.gamepassUrl) && !(updates.gamepassId ?? order.gamepassId)) {
    nextStatus = OrderStatus.WAIT_GAMEPASS_ID;
    updates.status = nextStatus;
  }

  if (Object.keys(updates).length === 0) {
    const last = lastReplyAt.get(order.id) ?? 0;
    if (Date.now() - last < debounceMs) return;
    lastReplyAt.set(order.id, Date.now());
    deps.logger.warn(
      { dealId: order.dealId, status: order.status, username, gamepassUrl, gamepassId },
      "NEW_MESSAGE validation failed"
    );
    if (!order.robloxUsername) {
      await deps.notifyBuyer(order.chatId, "Пришлите ник Roblox (одним сообщением).");
      return;
    }
    if (!order.gamepassUrl) {
      await deps.notifyBuyer(
        order.chatId,
        "Пришлите ссылку на ваш геймпасс и ID пасса (числом). Плейс должен быть публичным. Не забудьте отключить Regional Pricing."
      );
      return;
    }
    if (!order.gamepassId) {
      if (order.status !== OrderStatus.WAIT_GAMEPASS_ID) {
        await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.WAIT_GAMEPASS_ID } });
        logStatusChange(deps.logger, order.dealId, currentStatus, OrderStatus.WAIT_GAMEPASS_ID);
      }
      await deps.notifyBuyer(order.chatId, "Пришлите ID геймпасса (числом).");
      return;
    }
    if (wasFailed && dealId === order.dealId) {
      await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.READY_TO_BUY } });
      logStatusChange(deps.logger, order.dealId, currentStatus, OrderStatus.READY_TO_BUY);
      await deps.notifyBuyer(order.chatId, "Повторяю покупку. Пожалуйста, подождите.");
      deps.queue.enqueuePurchase(order.id);
    }
    return;
  }

  const updated = await prisma.order.update({ where: { id: order.id }, data: updates });
  logStatusChange(deps.logger, updated.dealId, currentStatus, updated.status);

  if (updated.status === OrderStatus.READY_TO_BUY) {
    const ahead = deps.queue.size();
    await deps.notifyBuyer(updated.chatId, `Заявка принята. Перед вами в очереди: ${ahead}`);
    deps.queue.enqueuePurchase(updated.id);
  }
}
