export enum OrderStatus {
  PAID_RECEIVED = "PAID_RECEIVED",
  WAIT_USERNAME = "WAIT_USERNAME",
  WAIT_GAMEPASS_URL = "WAIT_GAMEPASS_URL",
  WAIT_GAMEPASS_ID = "WAIT_GAMEPASS_ID",
  READY_TO_BUY = "READY_TO_BUY",
  WAIT_TOPUP = "WAIT_TOPUP",
  SUPPLIER_PENDING = "SUPPLIER_PENDING",
  SUPPLIER_ERROR = "SUPPLIER_ERROR",
  DONE = "DONE",
  FAILED = "FAILED",
}

export const OrderTransitions: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PAID_RECEIVED]: [OrderStatus.WAIT_USERNAME, OrderStatus.WAIT_GAMEPASS_URL, OrderStatus.READY_TO_BUY],
  [OrderStatus.WAIT_USERNAME]: [
    OrderStatus.WAIT_GAMEPASS_URL,
    OrderStatus.WAIT_GAMEPASS_ID,
    OrderStatus.READY_TO_BUY,
    OrderStatus.FAILED,
  ],
  [OrderStatus.WAIT_GAMEPASS_URL]: [OrderStatus.WAIT_GAMEPASS_ID, OrderStatus.READY_TO_BUY, OrderStatus.FAILED],
  [OrderStatus.WAIT_GAMEPASS_ID]: [OrderStatus.READY_TO_BUY, OrderStatus.FAILED],
  [OrderStatus.READY_TO_BUY]: [OrderStatus.SUPPLIER_PENDING, OrderStatus.WAIT_TOPUP, OrderStatus.FAILED],
  [OrderStatus.WAIT_TOPUP]: [OrderStatus.READY_TO_BUY, OrderStatus.FAILED],
  [OrderStatus.SUPPLIER_PENDING]: [OrderStatus.DONE, OrderStatus.FAILED, OrderStatus.SUPPLIER_ERROR],
  [OrderStatus.SUPPLIER_ERROR]: [OrderStatus.READY_TO_BUY, OrderStatus.FAILED],
  [OrderStatus.DONE]: [],
  [OrderStatus.FAILED]: [],
};

export const OrderStateTable = [
  [
    "PAID_RECEIVED",
    "WAIT_USERNAME",
    "WAIT_GAMEPASS_URL",
    "WAIT_GAMEPASS_ID",
    "READY_TO_BUY",
    "WAIT_TOPUP",
    "SUPPLIER_PENDING",
    "SUPPLIER_ERROR",
    "DONE",
  ],
  ["Ошибка", "FAILED", "FAILED", "FAILED", "FAILED", "FAILED", "FAILED"],
];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return OrderTransitions[from]?.includes(to) ?? false;
}
