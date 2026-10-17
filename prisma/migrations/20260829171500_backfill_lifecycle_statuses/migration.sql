UPDATE "PackingList" AS packing
SET "status" = 'DISPATCHED'
WHERE EXISTS (
  SELECT 1 FROM "Dispatch" AS dispatch
  WHERE dispatch."packingListId" = packing."id"
);

UPDATE "Invoice" AS invoice
SET "status" = CASE
  WHEN COALESCE((SELECT SUM(payment."amount") FROM "CustomerPayment" AS payment WHERE payment."invoiceId" = invoice."id"), 0) >= invoice."totalAmount" THEN 'PAID'::"InvoiceStatus"
  WHEN invoice."dueDate" IS NOT NULL AND invoice."dueDate" < NOW() THEN 'OVERDUE'::"InvoiceStatus"
  WHEN COALESCE((SELECT SUM(payment."amount") FROM "CustomerPayment" AS payment WHERE payment."invoiceId" = invoice."id"), 0) > 0 THEN 'PARTIALLY_PAID'::"InvoiceStatus"
  ELSE 'ISSUED'::"InvoiceStatus"
END
WHERE invoice."status" <> 'CANCELLED';
