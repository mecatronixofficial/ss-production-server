CREATE TYPE "KnittingMillType" AS ENUM ('OWN', 'OTHER');

ALTER TABLE "FabricProductionFlow"
ADD COLUMN "knittingMillType" "KnittingMillType" NOT NULL DEFAULT 'OWN';

CREATE INDEX "FabricProductionFlow_knittingMillType_status_idx"
ON "FabricProductionFlow"("knittingMillType", "status");
