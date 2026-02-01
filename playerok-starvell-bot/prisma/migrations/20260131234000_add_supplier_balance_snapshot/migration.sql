-- CreateTable
CREATE TABLE "SupplierBalanceSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "available" REAL NOT NULL,
    "pending" REAL NOT NULL,
    "frozen" REAL NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
