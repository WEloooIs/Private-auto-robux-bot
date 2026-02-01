import { chromium, Browser, BrowserContext, Page } from "playwright";
import fs from "fs";
import path from "path";

export type BuyFlowReq = {
  offerUrl: string;
  quantity: number;
  buyerNickname: string;
  gamepassUrl: string;
  sellerHello?: string;
  timeoutMs?: number;
};

export type BuyFlowEvents = {
  onBuyerInfo: (text: string) => Promise<void>;
  onSellerInfo: (text: string) => Promise<void>;
};

type NextData = any;

let browserSingleton: Browser | null = null;

function mustStatePath(): string {
  const p = process.env.STARVELL_STORAGE_STATE || "./config/starvell.storageState.json";
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) {
    throw new Error(`Нет storageState: ${abs}. Сначала сделай login tool.`);
  }
  return abs;
}

async function getBrowser(): Promise<Browser> {
  if (!browserSingleton) {
    const headless = (process.env.STARVELL_HEADLESS || "true").toLowerCase() !== "false";
    browserSingleton = await chromium.launch({ headless });
  }
  return browserSingleton;
}

function extractOfferId(url: string): number {
  const m = url.match(/\/offers\/(\d+)/);
  if (!m) throw new Error(`offerUrl должен содержать /offers/<id>: ${url}`);
  return Number(m[1]);
}

function extractNextData(html: string): NextData {
  const m = html.match(/__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
  if (!m) throw new Error("Не найден __NEXT_DATA__");
  return JSON.parse(m[1]);
}

async function apiPostJSON(ctx: BrowserContext, url: string, body: any) {
  const res = await ctx.request.post(url, { data: body });
  const status = res.status();
  const text = await res.text().catch(() => "");
  if (status >= 400) throw new Error(`POST ${url} -> HTTP ${status}. body=${text.slice(0, 500)}`);
  const ct = res.headers()["content-type"] || "";
  const json = ct.includes("application/json") ? await res.json().catch(() => null) : null;
  return { status, json, text };
}

async function getOfferMeta(page: Page) {
  const html = await page.content();
  const next = extractNextData(html);

  const chatId = next?.props?.pageProps?.chat?.id;
  const orderArgId = next?.props?.pageProps?.offer?.category?.orderArgs?.[0]?.id;

  return { chatId, orderArgId, next };
}

async function createOrder(ctx: BrowserContext, offerId: number, quantity: number, orderArgId: string, nickname: string) {
  const payload = {
    offerId,
    quantity,
    incomingOrderArgs: [{ id: orderArgId, value: nickname }],
  };

  const { json, text } = await apiPostJSON(ctx, "https://starvell.com/api/orders/create", payload);
  const orderId = json?.id || json?.orderId || json?.data?.id;
  if (!orderId) throw new Error(`Не смог извлечь orderId из orders/create: ${text.slice(0, 400)}`);
  return String(orderId);
}

async function sendMessage(ctx: BrowserContext, chatId: string, content: string) {
  await apiPostJSON(ctx, "https://starvell.com/api/messages/send", { chatId, content });
}

async function markRead(ctx: BrowserContext, chatId: string) {
  await apiPostJSON(ctx, "https://starvell.com/api/chats/read", { chatId });
}

async function listOrder(ctx: BrowserContext, orderId: string) {
  const payload = { filter: { id: orderId, userType: "buyer" }, with: { seller: true } };
  const { json } = await apiPostJSON(ctx, "https://starvell.com/api/orders/list", payload);
  const row = Array.isArray(json) ? json[0] : null;
  return row || null;
}

type ParsedMsg = { id: string; text: string; fromSeller: boolean; createdAt?: string };

function parseOrderMessagesFromNextData(next: NextData): ParsedMsg[] {
  const out: ParsedMsg[] = [];

  function walk(x: any) {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) {
      x.forEach(walk);
      return;
    }

    if (Array.isArray(x.messages)) {
      for (const m of x.messages) {
        const id = String(m?.id ?? m?.message?.id ?? "");
        const text = String(m?.content ?? m?.text ?? m?.message?.content ?? "");
        if (!id || !text) continue;

        const fromSeller =
          m?.senderType === "seller" || m?.authorType === "seller" || m?.userType === "seller";

        out.push({ id, text, fromSeller, createdAt: m?.createdAt || m?.created_at });
      }
    }

    for (const k of Object.keys(x)) walk(x[k]);
  }

  walk(next?.props?.pageProps);
  const map = new Map<string, ParsedMsg>();
  for (const m of out) map.set(m.id, m);
  return [...map.values()];
}

const SELLER_DONE_PATTERNS = [/отправил/i, /выполнил/i, /готово/i, /completed/i, /подтверд/i, /остав(ь|ьте) отзыв/i];

const SELLER_NEED_GAMEPASS_PATTERNS = [/созда(й|йте) геймпасс/i, /gamepass/i, /на сумму/i];

function shouldTreatAsDone(msg: string): boolean {
  return SELLER_DONE_PATTERNS.some((r) => r.test(msg));
}
function sellerAsksGamepass(msg: string): boolean {
  return SELLER_NEED_GAMEPASS_PATTERNS.some((r) => r.test(msg));
}

export async function runBuyFlow(req: BuyFlowReq, ev: BuyFlowEvents) {
  const browser = await getBrowser();
  const ctx = await browser.newContext({ storageState: mustStatePath() });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);

  try {
    await page.goto(req.offerUrl, { waitUntil: "domcontentloaded" });
    const { chatId, orderArgId } = await getOfferMeta(page);

    if (!orderArgId) throw new Error("Не нашёл orderArgId на странице оффера");
    const offerId = extractOfferId(req.offerUrl);

    const orderId = await createOrder(ctx, offerId, req.quantity, orderArgId, req.buyerNickname);

    await ev.onBuyerInfo(
      `Заказ создан на Starvell.\norderId: ${orderId}\n` +
        `Позиция в очереди определяется вашим ботом (если вы через очередь запускаете flow).`
    );

    if (chatId) {
      const sellerMsg =
        `Данные для выполнения:\n` +
        `Ник Roblox: ${req.buyerNickname}\n` +
        `Gamepass: ${req.gamepassUrl}\n` +
        (req.sellerHello ? `\n${req.sellerHello}\n` : "");

      await sendMessage(ctx, chatId, sellerMsg);
      await markRead(ctx, chatId).catch(() => {});
      await ev.onSellerInfo(`Отправил продавцу данные в чат (chatId=${chatId}).`);
    } else {
      await ev.onSellerInfo(`chatId не найден на оффере — чат не отправлен. (orderId=${orderId})`);
    }

    const timeout = req.timeoutMs ?? Number(process.env.STARVELL_ORDER_TIMEOUT_MS || 20 * 60 * 1000);
    const start = Date.now();

    const seen = new Set<string>();

    while (Date.now() - start < timeout) {
      const row = await listOrder(ctx, orderId).catch(() => null);
      const st = String(row?.status ?? "UNKNOWN");

      await page.goto(`https://starvell.com/order/${encodeURIComponent(orderId)}`, { waitUntil: "domcontentloaded" });
      const html = await page.content();
      const next = extractNextData(html);
      const msgs = parseOrderMessagesFromNextData(next);

      for (const m of msgs) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);

        const text = m.text || "";
        if (!m.fromSeller) continue;

        if (sellerAsksGamepass(text)) {
          await ev.onBuyerInfo(
            `Продавец запросил уточнение по gamepass.\n` +
              `Ответь ему: “Создайте геймпасс на нужную сумму и пришлите ссылку”.\n` +
              `Вот ваша ссылка на gamepass (если ещё не отправляли):\n${req.gamepassUrl}\n\n` +
              `Цитата продавца:\n${text}`
          );
        }

        if (shouldTreatAsDone(text)) {
          await ev.onBuyerInfo(
            `Похоже, продавец сообщил о выполнении.\n\n` +
              `Ожидать робуксы нужно 5–7 дней, такова политика Roblox.\n` +
              `Вы можете нажать на иконку Robux -> My Transactions, чтобы проверить отправление (Pending Robux)\n\n` +
              `https://www.roblox.com/transactions\n\n` +
              `Все выполнено, прошу вас подтвердить заказ, спасибо за покупку!\n` +
              `Так же я буду очень благодарен, если вы оставите отзыв!\n` +
              `Большое спасибо\n(*ˊᗜˋ*)ᵗᑋᵃᐢᵏ ᵞᵒᵘ\n\n` +
              `Цитата продавца:\n${text}`
          );

          return { orderId, status: st };
        }
      }

      if (st === "CANCELED" || st === "REFUNDED") {
        await ev.onBuyerInfo(`Заказ завершён статусом ${st}. Проверь детали в Starvell (orderId=${orderId}).`);
        return { orderId, status: st };
      }

      await new Promise((r) => setTimeout(r, 4000));
    }

    await ev.onBuyerInfo(`Таймаут ожидания ответа продавца. Проверь заказ вручную: ${orderId}`);
    return { orderId, status: "TIMEOUT" };
  } finally {
    await ctx.close();
  }
}
