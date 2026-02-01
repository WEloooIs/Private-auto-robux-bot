import type { SupplierClient, SupplierPurchaseRequest, SupplierPurchaseResponse, SupplierStatusResponse } from "./client";
import { runBuyRobux } from "../starvell/flowBuyRobux";

export class StarvellFlowSupplier implements SupplierClient {
  private readonly notifyBuyer: (text: string) => Promise<void>;
  private readonly logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void };
  private readonly states = new Map<string, { status: "PENDING" | "DONE" | "FAILED"; details?: string }>();

  constructor(options: {
    notifyBuyer: (text: string) => Promise<void>;
    logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void };
  }) {
    this.notifyBuyer = options.notifyBuyer;
    this.logger = options.logger;
  }

  async purchase(req: SupplierPurchaseRequest): Promise<SupplierPurchaseResponse> {
    const orderId = `starvell_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    this.states.set(orderId, { status: "PENDING" });

    void (async () => {
      try {
        const result = await runBuyRobux(
          {
            offerUrl: req.offer_url,
            quantity: req.amount_robux,
            buyerNick: req.roblox_username,
            gamepassUrl: req.gamepass_url,
            netRobux: req.amount_robux,
          },
          {
            notifyBuyer: this.notifyBuyer,
            log: (t) => this.logger.info(t),
          }
        );
        if (result.status === "SELLER_DONE") {
          this.states.set(orderId, { status: "DONE", details: `orderId=${result.orderId}` });
        } else if (result.status === "TIMEOUT") {
          this.states.set(orderId, { status: "FAILED", details: `timeout orderId=${result.orderId}` });
        } else if (result.status === "CANCELED" || result.status === "REFUNDED") {
          this.states.set(orderId, { status: "FAILED", details: `status=${result.status} orderId=${result.orderId}` });
        } else {
          this.states.set(orderId, { status: "PENDING", details: `status=${result.status} orderId=${result.orderId}` });
        }
      } catch (err: any) {
        this.logger.error({ err }, "Starvell flow failed");
        this.states.set(orderId, { status: "FAILED", details: err?.message ?? "flow failed" });
      }
    })();

    return { supplier_order_id: orderId };
  }

  async status(supplierOrderId: string): Promise<SupplierStatusResponse> {
    const state = this.states.get(supplierOrderId);
    if (!state) return { status: "FAILED", details: "Not found" };
    return { status: state.status, details: state.details };
  }
}
