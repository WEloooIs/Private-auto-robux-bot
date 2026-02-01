import {
  starvellOpenSession,
  starvellCloseSession,
  starvellCreateOrder,
  starvellOrdersList,
  starvellSendMessage,
  starvellChatRead,
} from "./starvellClient";
import {
  extractNextData,
  getOfferIdFromUrl,
  pickChatId,
  pickOrderArgIdForNickname,
  pickRequiredRubDetailed,
  parseMessages,
} from "./nextData";
import { grossFromNet } from "./robuxMath";
import { fetchStarvellFunds } from "../supplier/starvellWallet";

const DONE_PATTERNS = [/отправил/i, /выполнил/i, /готово/i, /completed/i, /done/i];
const SOFT_CONFIRM_PATTERNS = [/подтверд/i, /остав(ь|ьте) отзыв/i, /отзыв/i];

const NEED_GAMEPASS_PATTERNS = [/созда(й|йте) геймпасс/i, /gamepass/i, /на сумму/i];

function isDone(text: string) {
  return DONE_PATTERNS.some((r) => r.test(text));
}
function isSoftConfirm(text: string) {
  return SOFT_CONFIRM_PATTERNS.some((r) => r.test(text));
}
function asksGamepass(text: string) {
  return NEED_GAMEPASS_PATTERNS.some((r) => r.test(text));
}

export type BuyJob = {
  offerUrl: string;
  quantity: number;
  buyerNick: string;
  gamepassUrl: string;
  netRobux: number;
  messageToSellerExtra?: string;
  timeoutMs?: number;
};

export type BuyCallbacks = {
  notifyBuyer: (text: string) => Promise<void>;
  log: (text: string) => void;
  onState?: (state: {
    orderId?: string;
    lastSeenMessageId?: string;
    offerId?: number;
    grossRobux?: number;
    netRobux?: number;
    quantity?: number;
    chatId?: string;
    requiredRub?: number | null;
    requiredRubSource?: string | null;
    requiredRubExtract?: { tried: string[]; failReason?: string };
  }) => Promise<void>;
  onError?: (code: string, message: string) => Promise<void>;
};

export type BuyState = {
  existingOrderId?: string | null;
  lastSeenMessageId?: string | null;
};

export async function runBuyRobux(job: BuyJob, cb: BuyCallbacks, state?: BuyState) {
  const s = await starvellOpenSession();
  try {
    await s.page.goto(job.offerUrl, { waitUntil: "domcontentloaded" });
    const offerNext = extractNextData(await s.page.content());

    const chatId = pickChatId(offerNext);
    const orderArgId = pickOrderArgIdForNickname(offerNext);

    if (!orderArgId) throw new Error("Не найден orderArgId для поля никнейма (SSR оффера)");

    const offerId = getOfferIdFromUrl(job.offerUrl);
    const gross = grossFromNet(job.netRobux);
    const requiredRubInfo = pickRequiredRubDetailed(offerNext, job.quantity);
    const requiredRub = requiredRubInfo.value;

    if (cb.onState) {
      await cb.onState({
        offerId,
        grossRobux: gross,
        netRobux: job.netRobux,
        quantity: job.quantity,
        chatId,
        requiredRub,
        requiredRubSource: requiredRubInfo.source,
        requiredRubExtract: { tried: requiredRubInfo.tried, failReason: requiredRubInfo.failReason },
      });
    }

    let orderId = state?.existingOrderId ?? undefined;
    let createdNew = false;

    if (!orderId) {
      try {
        const wallet = await fetchStarvellFunds();
        if (requiredRub !== null && wallet.available < requiredRub) {
          const err = new Error("INSUFFICIENT_FUNDS");
          (err as any).code = "INSUFFICIENT_FUNDS";
          throw err;
        }
        if (requiredRub === null && wallet.available <= 0) {
          cb.log("wallet available=0 but requiredRub unknown; proceed to createOrder");
        }
      } catch (err: any) {
        const code = err?.code || err?.message || "WALLET_ERROR";
        if (cb.onError) {
          await cb.onError(String(code), `Wallet check failed: ${err?.message ?? err}`);
        }
        throw err;
      }

      try {
        orderId = await starvellCreateOrder(s.context, {
          offerId,
          quantity: job.quantity,
          incomingOrderArgs: [{ id: orderArgId, value: job.buyerNick }],
        });
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        if (/insufficient|недостат|balance/i.test(msg)) {
          const e = new Error("INSUFFICIENT_FUNDS");
          (e as any).code = "INSUFFICIENT_FUNDS";
          throw e;
        }
        throw err;
      }
      createdNew = true;
      cb.log(`Starvell order created: ${orderId}`);
      if (cb.onState) await cb.onState({ orderId });
    } else {
      cb.log(`Starvell order reused: ${orderId}`);
    }

    if (chatId && createdNew) {
      const msg =
        `Данные для выполнения:\n` +
        `Ник Roblox: ${job.buyerNick}\n` +
        `Gamepass: ${job.gamepassUrl}\n` +
        `Если нужно выставить цену gamepass: ${gross} R$ (чтобы получить ${job.netRobux} R$)\n` +
        (job.messageToSellerExtra ? `\n${job.messageToSellerExtra}\n` : "");

      await starvellSendMessage(s.context, chatId, msg);
      await starvellChatRead(s.context, chatId).catch(() => {});
    }

    const timeout = job.timeoutMs ?? Number(process.env.STARVELL_ORDER_TIMEOUT_MS || 20 * 60 * 1000);
    const start = Date.now();
    const seen = new Set<string>();
    if (state?.lastSeenMessageId) {
      seen.add(state.lastSeenMessageId);
    }

    let lastSeen = state?.lastSeenMessageId ?? undefined;

    while (Date.now() - start < timeout) {
      const row = await starvellOrdersList(s.context, orderId).catch(() => null);
      const st = String(row?.status ?? "UNKNOWN");
      if (st === "CANCELED" || st === "REFUNDED") {
        await cb.notifyBuyer(`Заказ отменён/рефанд (${st}). orderId=${orderId}`);
        return { orderId, status: st };
      }

      await s.page.goto(`https://starvell.com/order/${encodeURIComponent(orderId)}`, { waitUntil: "domcontentloaded" });
      const next = extractNextData(await s.page.content());
      const msgs = parseMessages(next);

      for (const m of msgs) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        if (!m.fromSeller) continue;
        lastSeen = m.id;
        if (cb.onState) await cb.onState({ lastSeenMessageId: lastSeen });

        const text = m.text;
        cb.log(`seller message: ${text.slice(0, 200)}`);

        if (asksGamepass(text)) {
          await cb.notifyBuyer(
            `Продавец запросил корректный gamepass.\n` +
              `Создайте gamepass на сумму ${gross} R$ (чтобы пришло ${job.netRobux} R$) и пришлите ссылку.\n` +
              `Ваша текущая ссылка: ${job.gamepassUrl}\n\n` +
              `Сообщение продавца:\n${text}`
          );
        }

        if (isDone(text)) {
          await cb.notifyBuyer(
            `Ожидать робуксы нужно 5-7 дней, такова политика Roblox\n` +
              `Вы можете нажать на иконку робуксов -> my transactions, чтобы проверить отправление робуксов (Pending robux)\n\n` +
              `https://www.roblox.com/transactions\n\n` +
              `Все выполнено, прошу вас подтвердить заказ, спасибо за покупку!\n` +
              `Так-же я буду очень благодарен, если вы оставите отзыв!Большое спасибо\n(*ˊᗜˋ*)ᵗᑋᵃᐢᵏ ᵞᵒᵘ\n\n` +
              `Сообщение продавца:\n${text}\n\n` +
              `orderId=${orderId}`
          );
          return { orderId, status: "SELLER_DONE" };
        }

        if (isSoftConfirm(text)) {
          await cb.notifyBuyer(
            `Поставщик просит подтвердить/оставить отзыв.\n` +
              `Проверьте выполнение и подтвердите заказ вручную.\n\n` +
              `Сообщение поставщика:\n${text}\n\n` +
              `orderId=${orderId}`
          );
        }
      }

      const elapsed = Date.now() - start;
      const delay = elapsed < 2 * 60 * 1000 ? 4000 : elapsed < 10 * 60 * 1000 ? 15000 : 30000;
      await new Promise((r) => setTimeout(r, delay));
    }

    await cb.notifyBuyer(`Таймаут ожидания ответа продавца. Проверь заказ вручную. orderId=${orderId}`);
    return { orderId, status: "TIMEOUT" };
  } finally {
    await starvellCloseSession(s);
  }
}
