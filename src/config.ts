import path from "path";
import fs from "fs";
import { z } from "zod";

const FALLBACK_DEFAULT_OFFER_URL = "https://starvell.com/offers/72878";

export interface EnvConfig {
  playerokToken: string;
  supplierBaseUrl: string;
  supplierMode: string;
  telegramBotToken: string;
  telegramOperatorChatId: string;
  starvellApiBase: string;
  starvellCookie: string;
  defaultOfferUrl: string;
  playerokWebhookPort: number;
  playerokWebhookPath: string;
  playerokWebhookToken: string;
  playerokProxyUrl: string;
  playerokProxyToken: string;
  logLevel: string;
}

export interface ProductConfig {
  byProductId: Record<string, string>;
  robuxAmountByProductId: Record<string, number>;
  defaultOfferUrl?: string;
}

const productsFileSchema = z
  .object({
    defaultOfferUrl: z.string().optional(),
    products: z
      .record(
        z.object({
          offerUrl: z.string().min(1, "offerUrl is required"),
          robuxAmount: z.number().int().positive().optional(),
        })
      )
      .default({}),
  })
  .strict();

const legacyProductsFileSchema = z
  .object({
    defaultOfferUrl: z.string().optional(),
    byProductId: z.record(z.string().min(1, "offerUrl is required")).default({}),
    robuxByProductId: z.record(z.number().int().positive()).optional(),
  })
  .strict();

type ProductsFileShape = z.infer<typeof productsFileSchema> | z.infer<typeof legacyProductsFileSchema>;

export function loadEnv(): EnvConfig {
  const playerokToken = process.env.PLAYEROK_TOKEN ?? "";
  const supplierBaseUrl = process.env.SUPPLIER_BASE_URL ?? "http://localhost:4000";
  const supplierMode = (process.env.SUPPLIER_MODE ?? "http").toLowerCase();
  const telegramBotToken = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const telegramOperatorChatId = (process.env.TELEGRAM_OPERATOR_CHAT_ID ?? "").trim();
  const starvellApiBase = (process.env.STARVELL_API_BASE ?? "https://starvell.com").trim();
  const starvellCookie = (process.env.STARVELL_COOKIE ?? "").trim();
  const defaultOfferUrl = process.env.DEFAULT_OFFER_URL ?? FALLBACK_DEFAULT_OFFER_URL;
  const playerokWebhookPortRaw = process.env.PLAYEROK_WEBHOOK_PORT ?? "3100";
  const playerokWebhookPort = Number.parseInt(playerokWebhookPortRaw, 10);
  const playerokWebhookPath = process.env.PLAYEROK_WEBHOOK_PATH ?? "/playerok/events";
  const playerokWebhookToken = process.env.PLAYEROK_WEBHOOK_TOKEN ?? "";
  const playerokProxyUrl = process.env.PLAYEROK_PROXY_URL ?? "http://localhost:3201";
  const playerokProxyToken = process.env.PLAYEROK_PROXY_TOKEN ?? "";
  const logLevel = process.env.LOG_LEVEL ?? "info";

  if (!playerokToken) {
    throw new Error("PLAYEROK_TOKEN is required");
  }

  return {
    playerokToken,
    supplierBaseUrl,
    supplierMode,
    telegramBotToken,
    telegramOperatorChatId,
    starvellApiBase,
    starvellCookie,
    defaultOfferUrl,
    playerokWebhookPort: Number.isFinite(playerokWebhookPort) ? playerokWebhookPort : 3100,
    playerokWebhookPath,
    playerokWebhookToken,
    playerokProxyUrl,
    playerokProxyToken,
    logLevel,
  };
}

export function loadProductConfig(): ProductConfig {
  const configDir = path.join(process.cwd(), "config");
  const configPath = path.join(configDir, "products.json");
  const examplePath = path.join(configDir, "products.example.json");
  const defaultOfferUrl = process.env.DEFAULT_OFFER_URL ?? FALLBACK_DEFAULT_OFFER_URL;
  const defaultConfig: ProductConfig = { byProductId: {}, robuxAmountByProductId: {}, defaultOfferUrl };

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  if (!fs.existsSync(configPath)) {
    const created = createConfigFromExampleOrDefault(configPath, examplePath, defaultOfferUrl);
    console.warn(
      created === "example"
        ? "config/products.json not found; created from products.example.json"
        : "config/products.json not found; created default config"
    );
    return defaultConfig;
  }

  const raw = fs.readFileSync(configPath, "utf8");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    const backupPath = backupInvalidConfig(configPath);
    createConfigFromExampleOrDefault(configPath, examplePath, defaultOfferUrl);
    console.warn(
      `config/products.json is invalid JSON; moved to ${path.basename(backupPath)} and created default config`
    );
    return defaultConfig;
  }

  const parsed = parseProductsConfig(parsedJson);
  if (!parsed) {
    return defaultConfig;
  }

  return parsed;
}

export function resolveOfferUrl(
  payloadOfferUrl: string | undefined,
  productId: string | undefined,
  productConfig: ProductConfig,
  envDefaultOfferUrl: string
): string {
  if (payloadOfferUrl && payloadOfferUrl.trim().length > 0) {
    return payloadOfferUrl.trim();
  }
  if (productId && productConfig.byProductId[productId]) {
    return productConfig.byProductId[productId];
  }
  if (productConfig.defaultOfferUrl && productConfig.defaultOfferUrl.trim().length > 0) {
    return productConfig.defaultOfferUrl.trim();
  }
  return envDefaultOfferUrl;
}

function parseProductsConfig(value: unknown): ProductConfig | null {
  const modern = productsFileSchema.safeParse(value);
  if (modern.success) {
    return normalizeProductsConfig(modern.data);
  }

  const legacy = legacyProductsFileSchema.safeParse(value);
  if (legacy.success) {
    return normalizeProductsConfig(legacy.data);
  }

  const issues = [...modern.error.issues, ...legacy.error.issues];
  const messages = formatZodIssues(issues);
  console.warn("config/products.json schema errors:");
  for (const message of messages) {
    console.warn(`- ${message}`);
  }
  return null;
}

function normalizeProductsConfig(data: ProductsFileShape): ProductConfig {
  if ("products" in data) {
    const products = (data.products ?? {}) as Record<string, { offerUrl: string }>;
    const byProductId: Record<string, string> = {};
    const robuxAmountByProductId: Record<string, number> = {};
    for (const [productId, entry] of Object.entries(products)) {
      if (entry && typeof entry.offerUrl === "string" && entry.offerUrl.length > 0) {
        byProductId[productId] = entry.offerUrl;
      }
      if (entry && typeof (entry as any).robuxAmount === "number" && (entry as any).robuxAmount > 0) {
        robuxAmountByProductId[productId] = (entry as any).robuxAmount;
      }
    }
    return {
      byProductId,
      robuxAmountByProductId,
      defaultOfferUrl: data.defaultOfferUrl,
    };
  }

  return {
    byProductId: data.byProductId ?? {},
    robuxAmountByProductId: data.robuxByProductId ?? {},
    defaultOfferUrl: data.defaultOfferUrl,
  };
}

export function resolveRobuxAmount(
  payloadAmount: number | undefined,
  productId: string | undefined,
  itemName: string | undefined,
  productConfig: ProductConfig
): number {
  if (payloadAmount && payloadAmount > 0) return payloadAmount;
  if (itemName) {
    const match = itemName.match(/(\d{1,6})\s*(robux|rbx|робук)/i);
    if (match?.[1]) return Number.parseInt(match[1], 10);
  }
  if (productId && productConfig.robuxAmountByProductId[productId]) {
    return productConfig.robuxAmountByProductId[productId];
  }
  return 0;
}

function createConfigFromExampleOrDefault(
  configPath: string,
  examplePath: string,
  defaultOfferUrl: string
): "example" | "default" {
  if (fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, configPath);
    return "example";
  }

  const defaultFile = {
    defaultOfferUrl,
    products: {},
  };
  fs.writeFileSync(configPath, JSON.stringify(defaultFile, null, 2));
  return "default";
}

function backupInvalidConfig(configPath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(path.dirname(configPath), `products.invalid.${timestamp}.json`);
  fs.renameSync(configPath, backupPath);
  return backupPath;
}

function formatZodIssues(issues: z.ZodIssue[]): string[] {
  return issues.map((issue) => {
    const pathLabel = issue.path.length > 0 ? issue.path.join(".") : "root";
    return `${pathLabel}: ${issue.message}`;
  });
}
