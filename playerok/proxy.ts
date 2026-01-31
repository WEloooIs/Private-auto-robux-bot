type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export async function sendMessageViaProxy(
  url: string,
  token: string,
  chatId: string,
  text: string,
  logger: Logger
): Promise<void> {
  await postJson(
    `${url}/send-message`,
    token,
    { chat_id: chatId, text },
    logger,
    "send-message"
  );
}

export async function completeDealViaProxy(
  url: string,
  token: string,
  dealId: string,
  logger: Logger
): Promise<void> {
  await postJson(
    `${url}/complete-deal`,
    token,
    { deal_id: dealId },
    logger,
    "complete-deal"
  );
}

async function postJson(
  url: string,
  token: string,
  payload: Record<string, unknown>,
  logger: Logger,
  label: string
) {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["X-Webhook-Token"] = token;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      logger.warn(`Proxy ${label} failed: ${res.status} ${text}`);
    }
  } catch (err: any) {
    logger.warn(`Proxy ${label} error: ${err?.message ?? "unknown"}`);
  }
}
