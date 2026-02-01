-- Add error tracking fields to Order
ALTER TABLE "Order" ADD COLUMN "lastErrorCode" TEXT;
ALTER TABLE "Order" ADD COLUMN "lastErrorMessage" TEXT;
ALTER TABLE "Order" ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0;
