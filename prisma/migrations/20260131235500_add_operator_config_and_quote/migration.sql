-- AlterTable
ALTER TABLE "SupplierTask" ADD COLUMN "quotedCostRub" REAL;

-- CreateTable
CREATE TABLE "OperatorConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "telegramChatId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
