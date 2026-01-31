import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { loadProductConfig } from "./config";

const DEFAULT_URL = "https://starvell.com/offers/49155";

function withTempProject(fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playerok-config-"));
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    fn(dir);
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function configPath(dir: string) {
  return path.join(dir, "config", "products.json");
}

describe("loadProductConfig", () => {
  const envSnapshot = { ...process.env };

  beforeEach(() => {
    process.env.DEFAULT_OFFER_URL = DEFAULT_URL;
  });

  afterEach(() => {
    process.env = { ...envSnapshot };
    vi.restoreAllMocks();
  });

  it("returns defaults and creates file when missing", () => {
    withTempProject((dir) => {
      const config = loadProductConfig();
      expect(config.byProductId).toEqual({});
      expect(config.defaultOfferUrl).toBe(DEFAULT_URL);
      expect(fs.existsSync(configPath(dir))).toBe(true);
    });
  });

  it("recovers from invalid JSON and creates new default file", () => {
    withTempProject((dir) => {
      const cfgDir = path.join(dir, "config");
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(path.join(cfgDir, "products.json"), "{invalid json");

      const config = loadProductConfig();
      expect(config.byProductId).toEqual({});
      expect(config.defaultOfferUrl).toBe(DEFAULT_URL);

      const files = fs.readdirSync(cfgDir);
      const hasBackup = files.some((name) => name.startsWith("products.invalid."));
      expect(hasBackup).toBe(true);
      expect(fs.existsSync(path.join(cfgDir, "products.json"))).toBe(true);
    });
  });

  it("returns defaults and logs schema errors when invalid", () => {
    withTempProject((dir) => {
      const cfgDir = path.join(dir, "config");
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(
        path.join(cfgDir, "products.json"),
        JSON.stringify({ defaultOfferUrl: 123, products: { "1": { offerUrl: 5 } } })
      );

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const config = loadProductConfig();

      expect(config.byProductId).toEqual({});
      expect(config.defaultOfferUrl).toBe(DEFAULT_URL);
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  it("returns mapping for valid config", () => {
    withTempProject((dir) => {
      const cfgDir = path.join(dir, "config");
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(
        path.join(cfgDir, "products.json"),
        JSON.stringify({
          defaultOfferUrl: "https://starvell.com/offers/999999",
          products: {
            "12345": { offerUrl: "https://starvell.com/offers/111111" },
          },
        })
      );

      const config = loadProductConfig();
      expect(config.defaultOfferUrl).toBe("https://starvell.com/offers/999999");
      expect(config.byProductId).toEqual({ "12345": "https://starvell.com/offers/111111" });
    });
  });
});
