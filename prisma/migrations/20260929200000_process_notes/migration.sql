-- Every process keeps its own notes (knitting already had them).
ALTER TABLE "FabricProductionFlow"
  ADD COLUMN "dyeingNotes" TEXT,
  ADD COLUMN "compactingNotes" TEXT;
