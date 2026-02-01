import { chromium, Browser } from "playwright";
import fs from "fs";
import path from "path";

export type StarvellAutoBuyReq = {
  offerUrl: string;
  quantity: number;
  nickname: string;
  messageToSeller?: string;
  waitForStatus?: "CREATED" | "COMPLETED";
  timeoutMs?: number;
};

export type StarvellAutoBuyRes = {
  orderId: string;
  status: string;
  chatId?: string;
};

let browserSingleton: Browser | null = null;

function mustEnvStatePath(): string {
  const p = process.env.STARVELL_STORAGE_STATE || "./config/starvell.storageState.json";
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) {
    throw new Error(`Нет storageState: ${abs}. Сначала сделай логин (npm run starvell:login).`);
  }
  return abs;
}

function debug(...args: any[]) {
  if ((process.env.STARVELL_DEBUG || "").toLowerCase() === "true") {
    console.log("[STARVELL]", ...args);
  }
}

async function getBrowser(): Promise<Browser> {
  if (!browserSingleton) {
    const headless = (process.env.STARVELL_HEADLESS || "true").toLowerCase() !== "false";
    browserSingleton = await chromium.launch({ headless });
  }
  return browserSingleton;
}

function extractOfferIdFromUrl(offerUrl: string): number {
  const m = offerUrl.match(/\/offers\/(\d+)/);
  if (!m) throw new Error(`offerUrl должен содержать /offers/<id>. Сейчас: ${offerUrl}`);
  return Number(m[1]);
}

function extractNextData(html: string): any {
  const m = html.match(/__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
  if (!m) throw new Error("Не найден __NEXT_DATA__ (Next.js SSR) на странице оффера");
  return JSON.parse(m[1]);
}

async function fetchOfferPageData(page: any): Promise<{ chatId?: string; orderArgId?: string }> {
  const html = await page.content();
  const next = extractNextData(html);

  const chatId = next?.props?.pageProps?.chat?.id;

  const orderArgId = next?.props?.pageProps?.offer?.category?.orderArgs?.[0]?.id;

  return { chatId, orderArgId };
}

async function apiPostJSON(context: any, url: string, body: any) {
  const res = await context.request.post(url, { data: body });
  const status = res.status();
  const ct = res.headers()["content-type"] || "";
  const text = await res.text().catch(() => "");

  if (status >= 400) {
    throw new Error(`POST ${url} -> HTTP ${status}. body=${text.slice(0, 500)}`);
  }

  if (!ct.includes("application/json")) return { status, json: null, text };
  const json = await res.json().catch(() => null);
  return { status, json, text };
}

async function createOrder(context: any, offerId: number, quantity: number, orderArgId: string, nickname: string) {
  const payload = {
    offerId,
    quantity,
    incomingOrderArgs: [{ id: orderArgId, value: nickname }],
  };

  const { status, json, text } = await apiPostJSON(context, "https://starvell.com/api/orders/create", payload);
  debug("create status", status, "json", json);

  const orderId = json?.id || json?.orderId || json?.data?.id;
  const orderStatus = json?.status || json?.data?.status;

  if (!orderId) {
    throw new Error(`Не смог извлечь orderId из ответа orders/create. resp=${text.slice(0, 500)}`);
  }

  return { orderId: String(orderId), status: String(orderStatus || "CREATED") };
}

async function orderStatus(context: any, orderId: string): Promise<string> {
  const payload = { filter: { id: orderId, userType: "buyer" }, with: { seller: true } };
  const { json, text } = await apiPostJSON(context, "https://starvell.com/api/orders/list", payload);

  if (!Array.isArray(json) || !json[0]) {
    throw new Error(`orders/list вернул не массив. resp=${text.slice(0, 500)}`);
  }

  return String(json[0].status || "UNKNOWN");
}

async function sendTyping(context: any, chatId: string, isTyping: boolean) {
  await apiPostJSON(context, "https://starvell.com/api/chats/send-typing", { chatId, isTyping });
}

async function sendMessage(context: any, chatId: string, content: string) {
  const { json } = await apiPostJSON(context, "https://starvell.com/api/messages/send", { chatId, content });
  return json?.message?.id ? String(json.message.id) : undefined;
}

async function markChatRead(context: any, chatId: string) {
  await apiPostJSON(context, "https://starvell.com/api/chats/read", { chatId });
}

async function completeOrder(context: any, orderId: string) {
  await apiPostJSON(context, "https://starvell.com/api/orders/complete", { id: orderId });
}

async function waitStatus(context: any, orderId: string, target: string, timeoutMs: number) {
  const start = Date.now();
  let last = "UNKNOWN";

  while (Date.now() - start < timeoutMs) {
    last = await orderStatus(context, orderId);
    debug("poll", orderId, last);

    if (last === target) return last;
    if (last === "CANCELED" || last === "REFUNDED") return last;

    await new Promise((r) => setTimeout(r, 3000));
  }
  return last;
}

export async function starvellAutoBuy(req: StarvellAutoBuyReq): Promise<StarvellAutoBuyRes> {
  const browser = await getBrowser();
  const state = mustEnvStatePath();

  const context = await browser.newContext({ storageState: state });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  try {
    await page.goto(req.offerUrl, { waitUntil: "domcontentloaded" });

    const { chatId, orderArgId } = await fetchOfferPageData(page);
    if (!orderArgId) {
      throw new Error("Не смог найти orderArgId (id поля никнейма) на странице оффера");
    }

    const offerId = extractOfferIdFromUrl(req.offerUrl);

    const created = await createOrder(context, offerId, req.quantity, orderArgId, req.nickname);

    if (chatId && req.messageToSeller) {
      await sendTyping(context, chatId, true).catch(() => {});
      await sendMessage(context, chatId, req.messageToSeller);
      await sendTyping(context, chatId, false).catch(() => {});
      await markChatRead(context, chatId).catch(() => {});
    }

    const want = req.waitForStatus || "COMPLETED";
    const timeout = req.timeoutMs ?? Number(process.env.STARVELL_ORDER_TIMEOUT_MS || 15 * 60 * 1000);

    const st = await waitStatus(context, created.orderId, want, timeout);

    if (st === "COMPLETED") {
      await completeOrder(context, created.orderId);
      return { orderId: created.orderId, status: "COMPLETED", chatId };
    }

    return { orderId: created.orderId, status: st, chatId };
  } finally {
    await context.close();
  }
}
