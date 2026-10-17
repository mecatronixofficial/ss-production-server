-- Every dispatched sale gets a delivery challan number (DC-<year>-<6 digits>), printed on the delivery challan that
-- goes with the vehicle. Sales dispatched before this are numbered now, in dispatch order per year, and the DC counter
-- continues after them.
ALTER TABLE "Sale" ADD COLUMN "challanNo" TEXT;

WITH numbered AS (
    SELECT "id",
           EXTRACT(YEAR FROM COALESCE("dispatchedAt", "updatedAt"))::int AS yr,
           ROW_NUMBER() OVER (
               PARTITION BY EXTRACT(YEAR FROM COALESCE("dispatchedAt", "updatedAt"))
               ORDER BY COALESCE("dispatchedAt", "updatedAt"), "saleNo"
           ) AS n
    FROM "Sale"
    WHERE "status" = 'DISPATCHED'
)
UPDATE "Sale" s
SET "challanNo" = 'DC-' || numbered.yr || '-' || LPAD(numbered.n::text, 6, '0')
FROM numbered
WHERE s."id" = numbered."id";

INSERT INTO "DocumentSequence" ("key", "value", "updatedAt")
SELECT 'DC-' || SPLIT_PART("challanNo", '-', 2), MAX(SPLIT_PART("challanNo", '-', 3)::int), NOW()
FROM "Sale"
WHERE "challanNo" IS NOT NULL
GROUP BY SPLIT_PART("challanNo", '-', 2)
ON CONFLICT ("key") DO UPDATE SET "value" = GREATEST("DocumentSequence"."value", EXCLUDED."value"), "updatedAt" = NOW();

CREATE UNIQUE INDEX "Sale_challanNo_key" ON "Sale"("challanNo");
