import { chromium, Browser } from "playwright";
import fs from "fs";
import path from "path";

export type StarvellFunds = {
  available: number;
  pending: number;
  frozen: number;
};

let browserSingleton: Browser | null = null;

function storageStatePath(): string {
  const p = process.env.STARVELL_STORAGE_STATE || "./config/starvell.storageState.json";
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) {
    throw new Error(`Нет storageState: ${abs}. Сначала сделай логин (npm run starvell:login).`);
  }
  return abs;
}

async function browser(): Promise<Browser> {
  if (!browserSingleton) {
    const headless = process.env.STARVELL_HEADLESS !== "false";
    browserSingleton = await chromium.launch({ headless });
  }
  return browserSingleton;
}

function extractNextData(html: string): any {
  const m = html.match(/__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
  if (!m) throw new Error("Не найден __NEXT_DATA__ в HTML /wallet");
  return JSON.parse(m[1]);
}

export async function fetchStarvellFunds(): Promise<StarvellFunds> {
  const b = await browser();
  const state = storageStatePath();

  const context = await b.newContext({ storageState: state });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  try {
    const resp = await page.goto("https://starvell.com/wallet", { waitUntil: "domcontentloaded" });

    const status = resp?.status() ?? 0;
    if (status === 404) throw new Error("Starvell /wallet вернул 404 (скорее всего нет авторизации/сессия протухла)");
    if (status >= 400) throw new Error(`Starvell /wallet вернул HTTP ${status}`);

    const html = await page.content();
    const next = extractNextData(html);

    const user = next?.props?.pageProps?.user;
    const available = Number(user?.balance?.rubBalance ?? 0);
    const frozen = Number(user?.holdedAmount ?? 0);

    const pending = 0;

    return {
      available: Number.isFinite(available) ? available : 0,
      pending,
      frozen: Number.isFinite(frozen) ? frozen : 0,
    };
  } finally {
    await context.close();
  }
}
