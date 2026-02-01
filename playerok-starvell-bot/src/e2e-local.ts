import "dotenv/config";
import { spawn } from "child_process";
import { PrismaClient } from "@prisma/client";

type Proc = ReturnType<typeof spawn>;

const prisma = new PrismaClient();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function spawnProcess(command: string, args: string[], cwd: string, readyPattern: RegExp, name: string): Promise<Proc> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const onData = (data: Buffer) => {
      const text = data.toString("utf8");
      process.stdout.write(`[${name}] ${text}`);
      if (readyPattern.test(text)) {
        cleanup();
        resolve(proc);
      }
    };

    const onErr = (data: Buffer) => {
      const text = data.toString("utf8");
      process.stderr.write(`[${name}] ${text}`);
    };

    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`${name} exited early with code ${code}`));
    };

    const cleanup = () => {
      proc.stdout?.off("data", onData);
      proc.stderr?.off("data", onErr);
      proc.off("exit", onExit);
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onErr);
    proc.on("exit", onExit);
  });
}

async function waitForHealth(url: string, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // ignore
    }
    await sleep(500);
  }
  throw new Error(`Health check failed for ${url}`);
}

async function postWebhook(eventType: string, payload: unknown) {
  const port = process.env.PLAYEROK_WEBHOOK_PORT ?? "3100";
  const path = process.env.PLAYEROK_WEBHOOK_PATH ?? "/playerok/events";
  const token = process.env.PLAYEROK_WEBHOOK_TOKEN ?? "";

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["X-Webhook-Token"] = token;

  const res = await fetch(`http://localhost:${port}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: eventType, payload }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Webhook POST failed: ${res.status} ${text}`);
  }
}

async function waitForDone(dealId: string, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const order = await prisma.order.findUnique({ where: { dealId } });
    if (order?.status === "DONE") return;
    if (order?.status === "FAILED") throw new Error("Order FAILED");
    await sleep(1000);
  }
  throw new Error("Timeout waiting for DONE");
}

async function main() {
  console.log("Ensure playerok-universal is running with PLAYEROK_WEBHOOK_URL set.");

  let supplier: Proc | null = null;
  let bot: Proc | null = null;

  try {
    supplier = await spawnProcess(
      "npm",
      ["start"],
      `${process.cwd()}\\supplier-service`,
      /listening on :4000/i,
      "supplier"
    );

    bot = await spawnProcess(
      "npm",
      ["run", "dev"],
      process.cwd(),
      /Playerok webhook listening/i,
      "bot"
    );

    await waitForHealth("http://localhost:3100/healthz", 10_000);

    const dealId = `e2e_${Date.now()}`;
    const chatId = "e2e_chat_1";

    await postWebhook("NEW_DEAL", {
      deal_id: dealId,
      chat_id: chatId,
      amount_robux: 100,
      product_id: "e2e_product",
      offer_url: "https://starvell.com/offers/49155",
    });

    await postWebhook("NEW_MESSAGE", {
      chat_id: chatId,
      text: "ник: E2EUser",
    });

    await postWebhook("NEW_MESSAGE", {
      chat_id: chatId,
      text: "геймпасс: https://www.roblox.com/game-pass/1234567/Test",
    });

    await waitForDone(dealId, 120_000);
    console.log("E2E local: DONE");
  } finally {
    if (bot) bot.kill();
    if (supplier) supplier.kill();
    await prisma.$disconnect();
  }
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
