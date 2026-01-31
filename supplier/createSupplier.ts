import { SupplierClient } from "./client";
import { StarvellPlaywrightSupplier } from "./starvellPlaywrightSupplier";
import { HttpSupplierClient } from "./httpClient";
import { OperatorSupplierClient } from "./operatorClient";
import type { StarvellReadClient } from "../starvell/readClient";
import type { SupplierBalanceService } from "./balance";

export function createSupplier(options: {
  supplierMode: string;
  supplierBaseUrl: string;
  notifyOperator?: (message: string) => Promise<void>;
  logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void };
  starvellRead?: StarvellReadClient;
  balanceService?: SupplierBalanceService;
}): SupplierClient {
  if (options.supplierMode === "playwright") {
    return new StarvellPlaywrightSupplier();
  }
  if (options.supplierMode === "operator") {
    if (!options.notifyOperator) {
      throw new Error("Operator supplier requires notifyOperator");
    }
    return new OperatorSupplierClient({
      notifyOperator: options.notifyOperator,
      logger: options.logger,
      starvellRead: options.starvellRead,
      balanceService: options.balanceService,
    });
  }
  return new HttpSupplierClient(options.supplierBaseUrl);
}
