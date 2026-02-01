import { chromium, Browser, BrowserContext, Page } from "playwright";
import fs from "fs";
import path from "path";

export type StarvellSession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
};

let browserSingleton: Browser | null = null;

function mustStatePath(): string {
  const p = process.env.STARVELL_STORAGE_STATE || "./config/starvell.storageState.json";
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) throw new Error(`Нет storageState: ${abs}`);
  return abs;
}

export async function starvellOpenSession(): Promise<StarvellSession> {
  if (!browserSingleton) {
    const headless = (process.env.STARVELL_HEADLESS || "true").toLowerCase() !== "false";
    browserSingleton = await chromium.launch({ headless });
  }
  const context = await browserSingleton.newContext({ storageState: mustStatePath() });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  return { browser: browserSingleton, context, page };
}

export async function starvellCloseSession(s: StarvellSession) {
  await s.context.close();
}

async function apiPostJSON(ctx: BrowserContext, url: string, data: any) {
  const res = await ctx.request.post(url, { data });
  const status = res.status();
  const text = await res.text().catch(() => "");
  if (status >= 400) throw new Error(`POST ${url} -> HTTP ${status}. body=${text.slice(0, 500)}`);
  const ct = res.headers()["content-type"] || "";
  const json = ct.includes("application/json") ? await res.json().catch(() => null) : null;
  return { status, json, text };
}

export async function starvellCreateOrder(ctx: BrowserContext, payload: {
  offerId: number;
  quantity: number;
  incomingOrderArgs: Array<{ id: string; value: string }>;
}) {
  const { json, text } = await apiPostJSON(ctx, "https://starvell.com/api/orders/create", payload);
  const orderId = json?.id || json?.orderId || json?.data?.id;
  if (!orderId) throw new Error(`Не смог извлечь orderId из orders/create: ${text.slice(0, 400)}`);
  return String(orderId);
}

export async function starvellOrdersList(ctx: BrowserContext, orderId: string) {
  const payload = { filter: { id: orderId, userType: "buyer" }, with: { seller: true } };
  const { json } = await apiPostJSON(ctx, "https://starvell.com/api/orders/list", payload);
  const row = Array.isArray(json) ? json[0] : null;
  return row || null;
}

export async function starvellSendMessage(ctx: BrowserContext, chatId: string, content: string) {
  await apiPostJSON(ctx, "https://starvell.com/api/messages/send", { chatId, content });
}

export async function starvellChatRead(ctx: BrowserContext, chatId: string) {
  await apiPostJSON(ctx, "https://starvell.com/api/chats/read", { chatId });
}
