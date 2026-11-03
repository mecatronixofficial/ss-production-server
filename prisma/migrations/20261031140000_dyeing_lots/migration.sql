-- A knitting batch's grey fabric can be dyed in several colours: each colour is a dyeing lot (its own batch row,
-- coded <knitting code>-DY01) that points back to the knitting batch.
ALTER TABLE "FabricProductionFlow" ADD COLUMN "parentId" TEXT;

ALTER TABLE "FabricProductionFlow"
  ADD CONSTRAINT "FabricProductionFlow_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "FabricProductionFlow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "FabricProductionFlow_parentId_idx" ON "FabricProductionFlow"("parentId");
