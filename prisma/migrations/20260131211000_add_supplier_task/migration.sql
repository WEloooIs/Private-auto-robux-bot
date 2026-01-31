-- CreateTable
CREATE TABLE "SupplierTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "offerUrl" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "robloxUsername" TEXT NOT NULL,
    "gamepassUrl" TEXT NOT NULL,
    "gamepassId" TEXT,
    "status" TEXT NOT NULL,
    "starvellOrderId" TEXT,
    "starvellChatId" TEXT,
    "lastStarvellMessage" TEXT,
    "lastStarvellMessageAt" DATETIME,
    "proof" TEXT,
    "failReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SupplierTask_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SupplierTask_orderId_idx" ON "SupplierTask"("orderId");

-- CreateIndex
CREATE INDEX "SupplierTask_status_idx" ON "SupplierTask"("status");
