import { EventEmitter } from "events";
import { Logger } from "pino";
import path from "path";
import fs from "fs";

export type DealEvent = {
  deal_id: string;
  chat_id: string;
  amount_robux: number;
  product_id?: string;
  offer_url?: string;
};

export type MessageEvent = {
  chat_id: string;
  text: string;
  sender: "buyer" | "seller" | "system";
};

export interface PlayerokClient {
  isStub?: boolean;
  onNewDeal(handler: (event: DealEvent) => void): void;
  onItemPaid(handler: (event: DealEvent) => void): void;
  onNewMessage(handler: (event: MessageEvent) => void): void;
  sendMessage(chatId: string, text: string): Promise<void>;
  sendMessageToChat?(chatId: string, text: string): Promise<void>;
  completeDeal(dealId: string): Promise<void>;
  confirmDeal?(dealId: string): Promise<void>;
  failDeal(dealId: string): Promise<void>;
  connect(): Promise<void>;
}

class StubPlayerokClient extends EventEmitter implements PlayerokClient {
  readonly isStub = true;
  constructor(private logger: Logger) {
    super();
  }

  onNewDeal(handler: (event: DealEvent) => void): void {
    this.on("NEW_DEAL", handler);
  }

  onItemPaid(handler: (event: DealEvent) => void): void {
    this.on("ITEM_PAID", handler);
  }

  onNewMessage(handler: (event: MessageEvent) => void): void {
    this.on("NEW_MESSAGE", handler);
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    this.logger.info({ chatId, text }, "Stub sendMessage");
  }

  async completeDeal(dealId: string): Promise<void> {
    this.logger.info({ dealId }, "Stub completeDeal");
  }

  async failDeal(dealId: string): Promise<void> {
    this.logger.info({ dealId }, "Stub failDeal");
  }

  async connect(): Promise<void> {
    this.logger.warn("playerok-universal not available; running in stub mode");
  }
}

export function createPlayerokClient(token: string, logger: Logger): PlayerokClient {
  try {
    const useNodeSdk = (process.env.PLAYEROK_USE_NODE_SDK ?? "").toLowerCase();
    if (useNodeSdk !== "true" && !process.env.PLAYEROK_UNIVERSAL_PATH) {
      logger.warn("PLAYEROK_USE_NODE_SDK disabled; running in webhook/stub mode");
      return new StubPlayerokClient(logger);
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sdk = loadPlayerokUniversal(logger) ?? require("playerok-universal");
    if (!sdk) {
      return new StubPlayerokClient(logger);
    }

    const client: any = new sdk.Client({ token });

    return {
      isStub: false,
      onNewDeal: (handler) => client.on("NEW_DEAL", handler),
      onItemPaid: (handler) => client.on("ITEM_PAID", handler),
      onNewMessage: (handler) => client.on("NEW_MESSAGE", handler),
      sendMessage: async (chatId, text) => {
        await client.sendMessage(chatId, text);
      },
      sendMessageToChat:
        typeof client.sendMessageToChat === "function"
          ? async (chatId, text) => {
              await client.sendMessageToChat(chatId, text);
            }
          : undefined,
      completeDeal: async (dealId) => {
        await client.completeDeal(dealId);
      },
      confirmDeal:
        typeof client.confirmDeal === "function"
          ? async (dealId) => {
              await client.confirmDeal(dealId);
            }
          : undefined,
      failDeal: async (dealId) => {
        await client.failDeal(dealId);
      },
      connect: async () => {
        await client.connect();
      }
    };
  } catch (err) {
    logger.warn({ err }, "Failed to load playerok-universal, using stub client");
    return new StubPlayerokClient(logger);
  }
}

function loadPlayerokUniversal(logger: Logger): any | null {
  const customPath = process.env.PLAYEROK_UNIVERSAL_PATH?.trim();
  if (!customPath) {
    return null;
  }

  const resolved = path.isAbsolute(customPath) ? customPath : path.join(process.cwd(), customPath);
  if (!fs.existsSync(resolved)) {
    logger.warn(`PLAYEROK_UNIVERSAL_PATH not found: ${resolved}`);
    return null;
  }

  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    const pkgJson = path.join(resolved, "package.json");
    const indexJs = path.join(resolved, "index.js");
    if (!fs.existsSync(pkgJson) && !fs.existsSync(indexJs)) {
      logger.warn(
        `PLAYEROK_UNIVERSAL_PATH directory missing package.json or index.js: ${resolved}`
      );
      return null;
    }
  }

  if (/\.(zip|7z|rar|tar|tgz|gz)$/i.test(resolved)) {
    logger.warn("PLAYEROK_UNIVERSAL_PATH points to an archive. Extract it and point to the folder or entry .js file.");
    return null;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(resolved);
  } catch (err) {
    logger.warn({ err }, "Failed to load playerok-universal from PLAYEROK_UNIVERSAL_PATH");
    return null;
  }
}
