-- Each ordered detail of a goods receipt line (count, quality, shade, GSM…) as the godown checked it.
ALTER TABLE "PurchaseReceiptItem" ADD COLUMN "checks" JSONB;
