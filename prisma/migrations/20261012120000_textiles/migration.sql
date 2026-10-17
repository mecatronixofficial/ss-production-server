-- Textiles become a list of their own (beside Distributors). Until now a textile was a name typed on each sale and
-- money entry; every name (in any case or spacing) becomes one textile, and its sales and money entries point to it.

CREATE TABLE "Textile" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "contactPerson" TEXT,
    "mobile" TEXT,
    "email" TEXT,
    "gst" TEXT,
    "address" TEXT,
    "city" TEXT,
    "paymentTerms" TEXT,
    "creditLimit" DECIMAL(14,2),
    "openingBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Textile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Textile_code_key" ON "Textile"("code");
CREATE UNIQUE INDEX "Textile_nameKey_key" ON "Textile"("nameKey");
CREATE INDEX "Textile_active_name_idx" ON "Textile"("active", "name");

ALTER TABLE "Sale" ADD COLUMN "textileId" TEXT;
ALTER TABLE "MoneyTransaction" ADD COLUMN "textileId" TEXT;
CREATE INDEX "Sale_textileId_idx" ON "Sale"("textileId");
CREATE INDEX "MoneyTransaction_textileId_kind_idx" ON "MoneyTransaction"("textileId", "kind");

-- One textile per name, numbered TXT-00001… in the order they first appeared. Its details are the latest ones typed
-- on a sale (sales carry GSTIN, phone and address; money entries only the name).
WITH named AS (
    SELECT LOWER(REGEXP_REPLACE(TRIM("partyName"), '[[:space:]]+', ' ', 'g')) AS "key",
           REGEXP_REPLACE(TRIM("partyName"), '[[:space:]]+', ' ', 'g') AS "name",
           NULLIF(UPPER(TRIM("partyGst")), '') AS "gst",
           NULLIF(TRIM("partyPhone"), '') AS "phone",
           NULLIF(TRIM("partyAddress"), '') AS "address",
           "createdAt" AS "at",
           1 AS "fromSale"
    FROM "Sale"
    WHERE "partyType" = 'TEXTILE' AND TRIM("partyName") <> ''
    UNION ALL
    SELECT LOWER(REGEXP_REPLACE(TRIM("partyName"), '[[:space:]]+', ' ', 'g')),
           REGEXP_REPLACE(TRIM("partyName"), '[[:space:]]+', ' ', 'g'),
           NULL, NULL, NULL, "createdAt", 0
    FROM "MoneyTransaction"
    WHERE "partyType" = 'TEXTILE' AND "partyName" IS NOT NULL AND TRIM("partyName") <> ''
),
firsts AS (
    SELECT "key", MIN("at") AS "first" FROM named GROUP BY "key"
),
latest AS (
    SELECT DISTINCT ON ("key") "key", "gst", "phone", "address"
    FROM named
    ORDER BY "key", "fromSale" DESC, "at" DESC
),
-- The name as shown: the latest spelling in normal case from a sale ("Sri Murugan Tex" over "SRI MURUGAN TEX" or
-- "sri murugan tex"). It can be changed on the Textiles list.
shown AS (
    SELECT DISTINCT ON ("key") "key", "name"
    FROM named
    ORDER BY "key", ("name" <> LOWER("name") AND "name" <> UPPER("name")) DESC, ("name" <> LOWER("name")) DESC, "fromSale" DESC, "at" DESC
)
INSERT INTO "Textile" ("id", "code", "name", "nameKey", "gst", "mobile", "address", "updatedAt")
SELECT gen_random_uuid()::text,
       'TXT-' || LPAD((ROW_NUMBER() OVER (ORDER BY f."first", f."key"))::text, 5, '0'),
       s."name", l."key", l."gst", l."phone", l."address", CURRENT_TIMESTAMP
FROM firsts f
JOIN latest l ON l."key" = f."key"
JOIN shown s ON s."key" = f."key";

UPDATE "Sale" s
SET "textileId" = t."id"
FROM "Textile" t
WHERE s."partyType" = 'TEXTILE' AND t."nameKey" = LOWER(REGEXP_REPLACE(TRIM(s."partyName"), '[[:space:]]+', ' ', 'g'));

UPDATE "MoneyTransaction" m
SET "textileId" = t."id"
FROM "Textile" t
WHERE m."partyType" = 'TEXTILE' AND m."partyName" IS NOT NULL
  AND t."nameKey" = LOWER(REGEXP_REPLACE(TRIM(m."partyName"), '[[:space:]]+', ' ', 'g'));

ALTER TABLE "Sale" ADD CONSTRAINT "Sale_textileId_fkey" FOREIGN KEY ("textileId") REFERENCES "Textile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MoneyTransaction" ADD CONSTRAINT "MoneyTransaction_textileId_fkey" FOREIGN KEY ("textileId") REFERENCES "Textile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
