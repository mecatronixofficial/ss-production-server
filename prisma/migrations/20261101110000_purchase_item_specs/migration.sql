-- A purchase line's details as ordered (yarn count, quality, blend, mill, bags; fabric type, dia, GSM, colour, rolls…).
ALTER TABLE "PurchaseOrderItem" ADD COLUMN "specs" JSONB;
