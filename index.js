const express = require("express");
const pino = require("pino");

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

app.use(express.json());

const orders = new Map();

app.post("/purchase", async (req, res) => {
  const { offer_url, amount_robux, roblox_username, gamepass_url, pay_method } = req.body || {};
  if (!offer_url || !amount_robux || !roblox_username || !gamepass_url || pay_method !== "balance") {
    return res.status(400).json({ error: "Invalid payload" });
  }

  // TODO: Replace stub with exfador/starvell_api integration
  // Example: const supplierOrderId = await starvellClient.purchase({ offer_url, amount_robux, roblox_username, gamepass_url, pay_method });

  const supplier_order_id = `stub_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const doneAt = Date.now() + 60_000 + Math.floor(Math.random() * 30_000);
  orders.set(supplier_order_id, { status: "PENDING", createdAt: Date.now(), doneAt });

  logger.info({ supplier_order_id, offer_url, amount_robux }, "Purchase created");

  return res.json({ supplier_order_id });
});

app.get("/status/:supplierOrderId", (req, res) => {
  const supplierOrderId = req.params.supplierOrderId;
  const order = orders.get(supplierOrderId);
  if (!order) {
    return res.status(404).json({ status: "FAILED", details: "Unknown order" });
  }

  if (Date.now() >= order.doneAt) {
    order.status = "DONE";
  }

  return res.json({ status: order.status });
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  logger.info(`Supplier service listening on :${port}`);
});
