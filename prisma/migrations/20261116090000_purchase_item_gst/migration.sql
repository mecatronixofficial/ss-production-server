-- Existing purchase orders retain their original value through the zero default.
ALTER TABLE "PurchaseOrderItem" ADD COLUMN "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_gstRate_check" CHECK ("gstRate" >= 0 AND "gstRate" <= 100);
