-- The yarn received register: a mill's delivery (DC) with one or more counts, each in stock under its own yarn code.
CREATE TABLE "YarnReceipt" (
    "id" TEXT NOT NULL,
    "receiptNo" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "dcNo" TEXT NOT NULL,
    "millName" TEXT NOT NULL,
    "agentName" TEXT,
    "warehouseId" TEXT NOT NULL,
    "vehicleNo" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "YarnReceipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "YarnReceiptLine" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "count" TEXT NOT NULL,
    "bags" TEXT,
    "bagCount" INTEGER,
    "weightKg" DECIMAL(14,3) NOT NULL,
    "ratePerKg" DECIMAL(12,2),
    "itemCode" TEXT NOT NULL,
    "stockTxnId" TEXT,
    CONSTRAINT "YarnReceiptLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "YarnReceipt_receiptNo_key" ON "YarnReceipt"("receiptNo");
CREATE INDEX "YarnReceipt_receivedAt_idx" ON "YarnReceipt"("receivedAt");
CREATE INDEX "YarnReceipt_millName_idx" ON "YarnReceipt"("millName");
CREATE UNIQUE INDEX "YarnReceiptLine_itemCode_key" ON "YarnReceiptLine"("itemCode");
CREATE INDEX "YarnReceiptLine_receiptId_idx" ON "YarnReceiptLine"("receiptId");

ALTER TABLE "YarnReceipt" ADD CONSTRAINT "YarnReceipt_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "YarnReceiptLine" ADD CONSTRAINT "YarnReceiptLine_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "YarnReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
