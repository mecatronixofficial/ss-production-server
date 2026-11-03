-- Like knitting's unused yarn: the grey fabric dyeing did not use and the dyed fabric compacting did not use go back
-- into a warehouse.
ALTER TABLE "FabricProductionFlow" ADD COLUMN "dyeingBalanceKg" DECIMAL(14,3);
ALTER TABLE "FabricProductionFlow" ADD COLUMN "greyReturnTxnId" TEXT;
ALTER TABLE "FabricProductionFlow" ADD COLUMN "compactingBalanceKg" DECIMAL(14,3);
ALTER TABLE "FabricProductionFlow" ADD COLUMN "dyedReturnTxnId" TEXT;
