-- Movements an admin cleared as needing no bill (old movements from before bills were issued).
ALTER TABLE "StockTransaction" ADD COLUMN "billWaivedAt" TIMESTAMP(3);

-- Every movement made before bills existed is old: clear it, so only new movements wait for a bill.
UPDATE "StockTransaction" SET "billWaivedAt" = CURRENT_TIMESTAMP WHERE "stockBillId" IS NULL;
