import http from "http";
import { URL } from "url";

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type WebhookHandler = (eventType: string, payload: unknown) => Promise<void>;

type WebhookOptions = {
  logger: Logger;
  port: number;
  path: string;
  token?: string;
  onEvent: WebhookHandler;
};

const MAX_BODY_BYTES = 1_000_000;

const NUMERIC_EVENT_TYPES: Record<number, string> = {
  1: "NEW_MESSAGE",
  2: "NEW_DEAL",
  10: "ITEM_PAID",
};

export function startPlayerokWebhook(options: WebhookOptions): http.Server {
  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200);
      res.end("OK");
      return;
    }

    if (method !== "POST" || url.pathname !== options.path) {
      res.writeHead(404);
      res.end();
      return;
    }

    if (options.token) {
      const headerToken = req.headers["x-webhook-token"];
      if (!headerToken || headerToken !== options.token) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
    }

    let body = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413);
        res.end("Payload too large");
        req.destroy();
        return;
      }
      body += chunk.toString("utf8");
    });

    req.on("end", async () => {
      let parsed: any;
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        res.writeHead(400);
        res.end("Invalid JSON");
        return;
      }

      const rawType = parsed.type ?? parsed.event ?? parsed.eventType ?? parsed.event_type;
      const eventType = normalizeEventType(rawType);
      if (!eventType) {
        options.logger.warn("Webhook received payload without event type");
        res.writeHead(400);
        res.end("Missing event type");
        return;
      }

      const payload = parsed.payload ?? parsed.data ?? parsed;
      const dealId = payload?.deal_id ?? payload?.dealId ?? payload?.id;
      const chatId = payload?.chat_id ?? payload?.chatId ?? payload?.chat?.id;
      const amountRobux = payload?.amount_robux ?? payload?.amountRobux ?? payload?.amount;
      const itemName = payload?.item_name ?? payload?.itemName;
      const productId = payload?.product_id ?? payload?.productId;
      options.logger.info(
        `Webhook event=${eventType} deal_id=${dealId ?? "-"} chat_id=${chatId ?? "-"} product_id=${productId ?? "-"} amount_robux=${amountRobux ?? "-"} item_name=${itemName ?? "-"}`
      );
      try {
        await options.onEvent(eventType, payload);
        res.writeHead(200);
        res.end("OK");
      } catch (err: any) {
        options.logger.error(`Webhook handler failed: ${err?.message ?? "Unknown error"}`);
        res.writeHead(500);
        res.end("Handler error");
      }
    });
  });

  server.listen(options.port, () => {
    options.logger.info(`Playerok webhook listening on :${options.port}${options.path}`);
  });

  return server;
}

function normalizeEventType(rawType: unknown): string | null {
  if (typeof rawType === "string" && rawType.trim().length > 0) {
    return rawType.trim().toUpperCase();
  }
  if (typeof rawType === "number") {
    return NUMERIC_EVENT_TYPES[rawType] ?? null;
  }
  return null;
}
