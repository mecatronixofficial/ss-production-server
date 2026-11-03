-- Receiving checks what arrived against what was sent: the DC quantity and the bags / rolls of a goods receipt line,
-- and the rolls / bags counted (and any remark) when a warehouse receives fabric from production.
ALTER TABLE "PurchaseReceiptItem" ADD COLUMN "dcQuantity" DECIMAL(14,3);
ALTER TABLE "PurchaseReceiptItem" ADD COLUMN "packages" TEXT;
ALTER TABLE "PurchaseReceiptItem" ADD COLUMN "packageCount" INTEGER;
ALTER TABLE "PurchaseReceiptItem" ADD COLUMN "details" TEXT;

ALTER TABLE "FabricFlowDelivery" ADD COLUMN "receivedPackages" INTEGER;
ALTER TABLE "FabricFlowDelivery" ADD COLUMN "receivedNotes" TEXT;
