-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dealId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "productId" TEXT,
    "amountRobux" INTEGER NOT NULL,
    "offerUrl" TEXT NOT NULL,
    "robloxUsername" TEXT,
    "gamepassUrl" TEXT,
    "supplierOrderId" TEXT,
    "status" TEXT NOT NULL,
    "statusDetails" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Order_dealId_key" ON "Order"("dealId");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE INDEX "Order_chatId_idx" ON "Order"("chatId");
