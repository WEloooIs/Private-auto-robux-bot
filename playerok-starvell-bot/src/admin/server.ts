import express from "express";
import path from "path";
import type { PrismaClient } from "@prisma/client";

type SupplierPoolLike = {
  getSnapshot: () => any;
  forceRefresh: (id?: string) => Promise<void>;
  applyConfig: (cfg: any) => void;
};

export function startAdminServer(opts: {
  prisma: PrismaClient;
  pool: SupplierPoolLike;
  port?: number;
}) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.get("/api/suppliers", (_req, res) => {
    res.json(opts.pool.getSnapshot());
  });

  app.post("/api/suppliers/refresh", async (_req, res) => {
    await opts.pool.forceRefresh();
    res.json({ ok: true });
  });

  app.post("/api/suppliers/refresh/:id", async (req, res) => {
    await opts.pool.forceRefresh(req.params.id);
    res.json({ ok: true });
  });

  app.get("/api/settings", async (_req, res) => {
    try {
      // @ts-ignore
      const row = await opts.prisma.settings.findUnique({ where: { key: "suppliersConfig" } });
      const cfg = row?.value ? JSON.parse(row.value) : null;
      res.json({ cfg });
    } catch {
      res.json({ cfg: null, note: "no_settings_table" });
    }
  });

  app.put("/api/settings", async (req, res) => {
    const cfg = req.body?.cfg;
    if (!cfg) return res.status(400).json({ error: "cfg required" });
    if (typeof cfg.maxConcurrency !== "number" || cfg.maxConcurrency < 1 || cfg.maxConcurrency > 20) {
      return res.status(400).json({ error: "maxConcurrency invalid" });
    }
    if (typeof cfg.maxUnitPriceRub !== "number" || cfg.maxUnitPriceRub <= 0) {
      return res.status(400).json({ error: "maxUnitPriceRub invalid" });
    }
    if (!Array.isArray(cfg.suppliers)) {
      return res.status(400).json({ error: "suppliers[] required" });
    }

    let saved = false;
    try {
      // @ts-ignore
      await opts.prisma.settings.upsert({
        where: { key: "suppliersConfig" },
        create: { key: "suppliersConfig", value: JSON.stringify(cfg) },
        update: { value: JSON.stringify(cfg) },
      });
      saved = true;
    } catch {
      // no settings table; continue
    }

    opts.pool.applyConfig(cfg);
    res.json({ ok: true, saved });
  });

  app.get("/api/profit", async (req, res) => {
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 7 * 86400e3);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();

    const orders = await opts.prisma.order.findMany({
      where: { createdAt: { gte: from, lte: to }, status: "DONE" as any },
      select: { id: true, createdAt: true, statusDetails: true },
      take: 5000,
    });

    let hasAnyMoney = false;
    const byDay = new Map<string, { revenue: number; cost: number; profit: number; count: number }>();
    for (const o of orders) {
      let details: any = {};
      try {
        details = o.statusDetails ? JSON.parse(o.statusDetails) : {};
      } catch {
        details = {};
      }
      const revenue = Number(details?.buyerPaidRub ?? 0);
      const cost = Number(details?.supplierCostRub ?? 0);
      if (revenue || cost) hasAnyMoney = true;

      const day = o.createdAt.toISOString().slice(0, 10);
      const profit = revenue - cost;

      const cur = byDay.get(day) ?? { revenue: 0, cost: 0, profit: 0, count: 0 };
      cur.revenue += revenue;
      cur.cost += cost;
      cur.profit += profit;
      cur.count += 1;
      byDay.set(day, cur);
    }

    if (!hasAnyMoney) {
      res.json({ supported: false, reason: "order_money_fields_missing" });
      return;
    }

    const rows = [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, v]) => ({ day, ...v }));

    res.json({ supported: true, from, to, rows });
  });

  const uiDir = path.resolve(process.cwd(), "admin-ui", "dist");
  app.use(express.static(uiDir));
  app.get("*", (_req, res) => res.sendFile(path.join(uiDir, "index.html")));

  const port = opts.port ?? Number(process.env.ADMIN_PORT || 3001);
  app.listen(port, "127.0.0.1", () => {
    console.log(`Admin UI: http://localhost:${port}`);
  });
}
