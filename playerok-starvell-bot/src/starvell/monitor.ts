import { prisma } from "../db/client";

const DONE_KEYWORDS = [
  "купил",
  "куплено",
  "отправил",
  "готово",
  "жду подтверждение",
  "жду подтверждение заказа",
  "отзыв пожалуйста",
  "жду отзыв",
  "подтверди заказ",
];

const WAIT_KEYWORDS = ["до 4 часов", "нагрузка", "в процессе"];

export interface StarvellMonitorOptions {
  cookie: string;
  logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void };
  notifyBuyer: (chatId: string, message: string) => Promise<void>;
}

export class StarvellChatMonitor {
  private readonly cookie: string;
  private readonly logger: StarvellMonitorOptions["logger"];
  private readonly notifyBuyer: StarvellMonitorOptions["notifyBuyer"];
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(options: StarvellMonitorOptions) {
    this.cookie = normalizeCookie(options.cookie);
    this.logger = options.logger;
    this.notifyBuyer = options.notifyBuyer;
  }

  start(taskId: string) {
    if (!this.cookie) {
      this.logger.warn("STARVELL_COOKIE is empty; chat monitor disabled");
      return;
    }
    if (this.timers.has(taskId)) return;
    const tick = async () => {
      try {
        await this.pollTask(taskId);
      } catch (err) {
        this.logger.error({ err, taskId }, "Starvell monitor poll failed");
      }
    };
    void tick();
    const timer = setInterval(tick, 30_000);
    this.timers.set(taskId, timer);
  }

  stop(taskId: string) {
    const timer = this.timers.get(taskId);
    if (timer) clearInterval(timer);
    this.timers.delete(taskId);
  }

  private async pollTask(taskId: string) {
    const task = await prisma.supplierTask.findUnique({ where: { id: taskId }, include: { order: true } });
    if (!task) {
      this.stop(taskId);
      return;
    }
    if (task.status === "DONE" || task.status === "FAILED") {
      this.stop(taskId);
      return;
    }
    if (!task.starvellOrderId) return;

    let chatId = task.starvellChatId ?? null;
    if (!chatId) {
      chatId = await fetchChatId(task.starvellOrderId, this.cookie, this.logger);
      if (chatId) {
        await prisma.supplierTask.update({ where: { id: taskId }, data: { starvellChatId: chatId } });
      }
    }

    if (!chatId) return;

    const messages = await fetchMessages(chatId, this.cookie, this.logger);
    if (!messages || messages.length === 0) return;
    const last = messages[0];
    const lastText = (last.text ?? last.message ?? "").toString();
    const lastAt = parseMessageTime(last.createdAt ?? last.created_at);

    const isNew =
      lastText &&
      (task.lastStarvellMessage !== lastText || (lastAt && (!task.lastStarvellMessageAt || lastAt > task.lastStarvellMessageAt)));

    if (!isNew) return;

    await prisma.supplierTask.update({
      where: { id: taskId },
      data: {
        lastStarvellMessage: lastText || null,
        lastStarvellMessageAt: lastAt ?? new Date(),
      },
    });

    const textLower = lastText.toLowerCase();
    if (DONE_KEYWORDS.some((k) => textLower.includes(k))) {
      await prisma.supplierTask.update({
        where: { id: taskId },
        data: { status: "READY_TO_CONFIRM" },
      });
      this.logger.info(`Starvell ready to confirm task=${taskId}`);
      await this.notifyBuyer(task.order.chatId, "Поставщик сообщил выполнение заказа. Проверьте получение и подтвердите, пожалуйста.");
      return;
    }

    if (WAIT_KEYWORDS.some((k) => textLower.includes(k))) {
      this.logger.info(`Starvell still waiting task=${taskId}`);
    }
  }
}

function normalizeCookie(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.includes("=")) return trimmed;
  return `session=${trimmed}`;
}

async function fetchChatId(orderId: string, cookie: string, logger: StarvellMonitorOptions["logger"]): Promise<string | null> {
  try {
    const resp = await fetch(`https://starvell.com/order/${orderId}`, {
      headers: { cookie, "user-agent": "Mozilla/5.0" },
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    const nextData = extractNextData(html);
    const chatId = findChatId(nextData?.props?.pageProps);
    if (chatId) return chatId;
  } catch (err) {
    logger.error({ err, orderId }, "Failed to fetch Starvell order page");
  }
  return null;
}

async function fetchMessages(chatId: string, cookie: string, logger: StarvellMonitorOptions["logger"]): Promise<any[] | null> {
  try {
    const resp = await fetch("https://starvell.com/api/messages/list", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "user-agent": "Mozilla/5.0",
      },
      body: JSON.stringify({ chatId, limit: 20 }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const messages = (data?.messages ?? data?.data ?? data?.items ?? data?.result ?? []).slice(0, 20);
    if (Array.isArray(messages)) return messages;
  } catch (err) {
    logger.error({ err, chatId }, "Failed to fetch Starvell messages");
  }
  return null;
}

function extractNextData(html: string): any | null {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function findChatId(obj: any): string | null {
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.chatId === "string" || typeof obj.chatId === "number") return String(obj.chatId);
  if (typeof obj.chat_id === "string" || typeof obj.chat_id === "number") return String(obj.chat_id);
  for (const value of Object.values(obj)) {
    const found = findChatId(value);
    if (found) return found;
  }
  return null;
}

function parseMessageTime(value: any): Date | null {
  if (!value) return null;
  if (typeof value === "number") return new Date(value);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}
