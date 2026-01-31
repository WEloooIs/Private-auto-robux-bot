import "dotenv/config";

const port = process.env.PLAYEROK_WEBHOOK_PORT ?? "3100";
const path = process.env.PLAYEROK_WEBHOOK_PATH ?? "/playerok/events";
const token = process.env.PLAYEROK_WEBHOOK_TOKEN ?? "";

const payload = {
  type: "NEW_DEAL",
  payload: {
    deal_id: "test_deal_123",
    chat_id: "test_chat_456",
    amount_robux: 100,
    product_id: "test_product_789",
    offer_url: "https://starvell.com/offers/49155",
  },
};

async function main() {
  const url = `http://localhost:${port}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["X-Webhook-Token"] = token;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  console.log(`POST ${url} -> ${response.status} ${text}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
