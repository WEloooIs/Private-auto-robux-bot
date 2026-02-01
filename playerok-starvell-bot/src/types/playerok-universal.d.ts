declare module "playerok-universal" {
  export class PlayerokUniversal {
    constructor(options: { token: string });
    on(event: string, handler: (payload: any) => void): void;
    sendMessage?(chatId: string, message: string): Promise<void>;
    sendMessageToChat?(chatId: string, message: string): Promise<void>;
    completeDeal?(dealId: string): Promise<void>;
    confirmDeal?(dealId: string): Promise<void>;
  }
}