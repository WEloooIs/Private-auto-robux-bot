export interface SupplierPurchaseRequest {
  offer_url: string;
  amount_robux: number;
  roblox_username: string;
  gamepass_url: string;
  pay_method: "balance";
}

export interface SupplierPurchaseResponse {
  supplier_order_id: string;
}

export type SupplierStatus = "PENDING" | "DONE" | "FAILED";

export interface SupplierStatusResponse {
  status: SupplierStatus;
  details?: string;
}

export interface SupplierClient {
  purchase(request: SupplierPurchaseRequest): Promise<SupplierPurchaseResponse>;
  status(supplierOrderId: string): Promise<SupplierStatusResponse>;
}