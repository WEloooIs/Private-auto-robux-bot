import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export async function ensureDatabaseReady(logger: Logger): Promise<void> {
  const autoMigrate = (process.env.AUTO_MIGRATE ?? "true").toLowerCase();
  if (autoMigrate === "false" || autoMigrate === "0" || autoMigrate === "no") {
    logger.info("AUTO_MIGRATE disabled; skipping prisma migrate deploy");
    return;
  }

  const prismaBin = resolvePrismaBin();
  if (!prismaBin) {
    logger.warn("Prisma CLI not found; skipping auto-migrate");
    return;
  }

  const result = spawnSync(
    process.platform === "win32" ? "cmd" : "npx",
    process.platform === "win32"
      ? ["/c", prismaBin, "migrate", "deploy"]
      : ["prisma", "migrate", "deploy"],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: "pipe",
      shell: false,
      windowsHide: true,
    }
  );

  if (result.error) {
    logger.warn(`Prisma migrate deploy failed. ${result.error.message}`);
    return;
  }

  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString("utf8").trim() : "";
    const stdout = result.stdout ? result.stdout.toString("utf8").trim() : "";
    logger.warn(
      `Prisma migrate deploy failed. ${stderr || stdout || "Unknown error"}`
    );
    return;
  }

  logger.info("Prisma migrate deploy completed");
}

function resolvePrismaBin(): string | null {
  const binName = process.platform === "win32" ? "prisma.cmd" : "prisma";
  const binPath = path.join(process.cwd(), "node_modules", ".bin", binName);
  if (fs.existsSync(binPath)) {
    return binPath;
  }
  return null;
}
