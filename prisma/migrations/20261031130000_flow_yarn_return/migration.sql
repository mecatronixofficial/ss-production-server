-- The yarn knitting did not use, put back into stock when knitting finishes.
-- AlterTable
ALTER TABLE "FabricProductionFlow" ADD COLUMN "yarnReturnTxnId" TEXT;
