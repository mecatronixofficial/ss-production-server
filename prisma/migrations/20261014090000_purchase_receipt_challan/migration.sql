-- A goods receipt keeps what came with the material, for the received challan the office files:
-- the distributor's challan / invoice number, the vehicle and any remarks.
ALTER TABLE "PurchaseReceipt" ADD COLUMN "challanNo" TEXT;
ALTER TABLE "PurchaseReceipt" ADD COLUMN "vehicleNo" TEXT;
ALTER TABLE "PurchaseReceipt" ADD COLUMN "notes" TEXT;
