-- Default new purchase items to 18% without changing existing saved percentages.
ALTER TABLE "PurchaseOrderItem" ALTER COLUMN "gstRate" SET DEFAULT 18;
