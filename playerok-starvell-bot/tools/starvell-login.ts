import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const STORAGE_STATE_PATH =
  process.env.STARVELL_STORAGE_STATE || path.join(process.cwd(), "config", "starvell.storageState.json");

(async () => {
  fs.mkdirSync(path.dirname(STORAGE_STATE_PATH), { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://starvell.com/", { waitUntil: "domcontentloaded" });

  console.log("Залогинься вручную в открывшемся окне.");
  console.log("После успешного входа нажми ENTER в терминале.");

  await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));

  await context.storageState({ path: STORAGE_STATE_PATH });
  await browser.close();

  console.log(`OK: storageState сохранён в ${STORAGE_STATE_PATH}`);
  process.exit(0);
})();
