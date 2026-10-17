-- Yarn batches can start from yarn already in stock, not only a new purchase.
-- PI, party, mill and delivery place are only required for purchases (enforced in the API).
CREATE TYPE "FabricSource" AS ENUM ('PURCHASE', 'STOCK');
ALTER TABLE "FabricProductionFlow" ADD COLUMN "source" "FabricSource" NOT NULL DEFAULT 'PURCHASE';
ALTER TABLE "FabricProductionFlow"
  ALTER COLUMN "piNo" DROP NOT NULL,
  ALTER COLUMN "partyDetails" DROP NOT NULL,
  ALTER COLUMN "millDetails" DROP NOT NULL,
  ALTER COLUMN "deliveryPlace" DROP NOT NULL;

-- Batch codes change from YF-<year>-000001 to SS-<year>-001 (src/common/numbering.ts).
-- Existing batches are renumbered in creation order within each year, and the old code is kept in the audit log.
WITH renumbered AS (
  SELECT
    "id",
    "flowNo" AS "oldNo",
    'SS-' || EXTRACT(YEAR FROM "createdAt")::int || '-' ||
      LPAD((ROW_NUMBER() OVER (PARTITION BY EXTRACT(YEAR FROM "createdAt") ORDER BY "createdAt", "id"))::text, 3, '0') AS "newNo"
  FROM "FabricProductionFlow"
), updated AS (
  UPDATE "FabricProductionFlow" AS f
  SET "flowNo" = r."newNo", "updatedAt" = NOW()
  FROM renumbered AS r
  WHERE f."id" = r."id"
  RETURNING f."id", r."oldNo", r."newNo"
)
INSERT INTO "AuditLog" ("id", "action", "module", "entity", "entityId", "previousValue", "newValue", "createdAt")
SELECT
  gen_random_uuid()::text,
  'BATCH_CODE_CHANGED',
  'production',
  'FabricProductionFlow',
  "id",
  jsonb_build_object('flowNo', "oldNo"),
  jsonb_build_object('flowNo', "newNo", 'reason', 'Batch codes changed to SS-<year>-<number>'),
  NOW()
FROM updated;

-- New batches continue after the renumbered ones.
INSERT INTO "DocumentSequence" ("key", "value", "updatedAt")
SELECT 'SS-' || EXTRACT(YEAR FROM "createdAt")::int, COUNT(*), NOW()
FROM "FabricProductionFlow"
GROUP BY EXTRACT(YEAR FROM "createdAt")
ON CONFLICT ("key") DO UPDATE SET "value" = GREATEST("DocumentSequence"."value", EXCLUDED."value"), "updatedAt" = NOW();
