-- Compacting has its own party and mill, like knitting and dyeing.
ALTER TABLE "FabricProductionFlow"
  ADD COLUMN "compactingPartyDetails" TEXT,
  ADD COLUMN "compactingMillDetails" TEXT;
