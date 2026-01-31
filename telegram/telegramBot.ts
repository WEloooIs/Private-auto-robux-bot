export interface TelegramBotOptions {
  token: string;
  operatorChatId?: string;
  logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void };
}

export class TelegramBot {
  private readonly token: string;
  private readonly operatorChatId?: string;
  private readonly logger: TelegramBotOptions["logger"];
  private offset = 0;

  constructor(options: TelegramBotOptions) {
    this.token = options.token;
    this.operatorChatId = options.operatorChatId;
    this.logger = options.logger;
  }

  setOperatorChatId(chatId: string) {
    (this as any).operatorChatId = chatId;
  }

  getOperatorChatId(): string | undefined {
    return (this as any).operatorChatId;
  }

  async sendToOperator(text: string): Promise<void> {
    if (!this.token || !this.operatorChatId) return;
    await this.sendMessage(this.operatorChatId, text);
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.token) return;
    await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  }

  startPolling(onCommand: (text: string, chatId: string) => Promise<void>) {
    if (!this.token) return;
    const poll = async () => {
      try {
        const url = `https://api.telegram.org/bot${this.token}/getUpdates?timeout=30&offset=${this.offset}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Telegram getUpdates failed ${resp.status}`);
        const data = await resp.json();
        const updates = data.result || [];
        for (const update of updates) {
          this.offset = update.update_id + 1;
          const message = update.message || update.edited_message;
          if (!message || !message.text) continue;
          const chatId = String(message.chat?.id ?? "");
          const text = String(message.text ?? "");

          await onCommand(text, chatId);
        }
      } catch (err) {
        this.logger.error({ err }, "Telegram polling error");
      } finally {
        setTimeout(poll, 1500);
      }
    };
    void poll();
  }
}
