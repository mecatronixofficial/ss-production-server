-- Knitting can take only the yarn a planned fabric weight needs (the rest stays in the warehouse).
ALTER TABLE "FabricProductionFlow" ADD COLUMN "plannedFabricKg" DECIMAL(14,3);
