import { chromium, Browser } from "playwright";
import fs from "fs";
import path from "path";
import { SupplierClient, SupplierPurchaseRequest, SupplierStatusResponse } from "./client";

export class StarvellPlaywrightSupplier implements SupplierClient {
  private browser: Browser | null = null;

  private storageStatePath =
    process.env.STARVELL_STORAGE_STATE || path.join(process.cwd(), "config", "starvell.storageState.json");

  private headless = process.env.STARVELL_HEADLESS !== "false";

  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: this.headless });
    }
    return this.browser;
  }

  private ensureStateFile() {
    const abs = path.resolve(this.storageStatePath);
    if (!fs.existsSync(abs)) {
      throw new Error(`Нет storageState файла: ${abs}. Сначала запусти: npm run starvell:login`);
    }
    return abs;
  }

  async purchase(req: SupplierPurchaseRequest): Promise<string> {
    const browser = await this.getBrowser();
    const storageStateAbs = this.ensureStateFile();

    const context = await browser.newContext({ storageState: storageStateAbs });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);

    try {
      await page.goto(req.offer_url, { waitUntil: "domcontentloaded" });

      await page.getByText(/способ оплаты/i).click();
      await page.getByText(/баланс на сайте/i).click();

      await page.getByPlaceholder(/получу/i).fill(String(req.amount_robux));
      await page.getByPlaceholder(/никнейм/i).fill(req.roblox_username);

      const createResp = page.waitForResponse((r) => {
        const u = r.url();
        return u.includes("/api/") && (u.includes("order") || u.includes("orders")) && u.includes("create") && r.status() >= 200 && r.status() < 300;
      });

      await page.getByRole("button", { name: /купить/i }).click();

      const resp = await createResp;
      const json = await resp.json();

      const starvellOrderId = json?.id || json?.orderId || json?.data?.id;
      if (!starvellOrderId) {
        throw new Error("Не смог извлечь starvell order id из ответа create-order");
      }

      return String(starvellOrderId);
    } finally {
      await context.close();
    }
  }

  async status(starvellOrderId: string): Promise<SupplierStatusResponse> {
    const browser = await this.getBrowser();
    const storageStateAbs = this.ensureStateFile();

    const context = await browser.newContext({ storageState: storageStateAbs });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);

    try {
      await page.goto(`https://starvell.com/order/${encodeURIComponent(starvellOrderId)}`, {
        waitUntil: "domcontentloaded",
      });

      const body = (await page.locator("body").innerText()).toLowerCase();

      if (body.includes("выполнен") || body.includes("completed")) {
        return { status: "DONE", details: `starvell_id=${starvellOrderId}` };
      }
      if (body.includes("отмен") || body.includes("canceled")) {
        return { status: "FAILED", details: `canceled starvell_id=${starvellOrderId}` };
      }
      return { status: "PENDING", details: `starvell_id=${starvellOrderId}` };
    } finally {
      await context.close();
    }
  }
}
