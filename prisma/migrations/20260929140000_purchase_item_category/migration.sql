-- Each purchase-order line says what stock it becomes, chosen when ordering, instead of one category guessed per receipt.
ALTER TABLE "PurchaseOrderItem" ADD COLUMN "category" "StockCategory";

-- Lines already received keep the category they were received as.
UPDATE "PurchaseOrderItem" AS i
SET "category" = r."category"
FROM "PurchaseReceiptItem" AS ri
JOIN "PurchaseReceipt" AS r ON r."id" = ri."purchaseReceiptId"
WHERE ri."purchaseOrderItemId" = i."id" AND i."category" IS NULL;

-- Purchase orders made before destinations existed: the warehouse they were last received into.
UPDATE "PurchaseOrder" AS po
SET "warehouseId" = (
  SELECT r."warehouseId" FROM "PurchaseReceipt" AS r WHERE r."purchaseOrderId" = po."id" ORDER BY r."receivedAt" DESC LIMIT 1
)
WHERE po."warehouseId" IS NULL AND EXISTS (SELECT 1 FROM "PurchaseReceipt" AS r WHERE r."purchaseOrderId" = po."id");
