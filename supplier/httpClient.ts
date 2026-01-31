import { SupplierClient, SupplierPurchaseRequest, SupplierPurchaseResponse, SupplierStatusResponse } from "./client";

export class HttpSupplierClient implements SupplierClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async purchase(request: SupplierPurchaseRequest): Promise<SupplierPurchaseResponse> {
    const response = await fetch(`${this.baseUrl}/purchase`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Supplier purchase failed: ${response.status} ${body}`);
    }

    return (await response.json()) as SupplierPurchaseResponse;
  }

  async status(supplierOrderId: string): Promise<SupplierStatusResponse> {
    const response = await fetch(`${this.baseUrl}/status/${encodeURIComponent(supplierOrderId)}`, {
      method: "GET",
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Supplier status failed: ${response.status} ${body}`);
    }

    return (await response.json()) as SupplierStatusResponse;
  }
}