-- Suppliers are Distributors now: their codes move from SUP-00012 to DST-00012 (same number, at least 5 digits).
-- Purchase orders and payments point at distributors by id, so nothing else changes.
-- A code is left as it is when its new form would clash (two old codes with the same number, or the new code
-- already in use); those can be fixed from the Distributors page.
WITH candidates AS (
  SELECT
    "id",
    'DST-' || lpad(num, greatest(5, length(num)), '0') AS target
  FROM (
    SELECT "id", coalesce(nullif(ltrim(substring("code" FROM '([0-9]+)\s*$'), '0'), ''), '0') AS num
    FROM "Supplier"
    WHERE "code" ~* '^\s*sup[\s_-]*[0-9]+\s*$'
  ) AS numbered
),
clear AS (
  SELECT c."id", c.target
  FROM candidates AS c
  WHERE (SELECT count(*) FROM candidates AS c2 WHERE c2.target = c.target) = 1
    AND NOT EXISTS (SELECT 1 FROM "Supplier" AS o WHERE upper(o."code") = c.target AND o."id" <> c."id")
)
UPDATE "Supplier" AS s
SET "code" = clear.target, "updatedAt" = NOW()
FROM clear
WHERE s."id" = clear."id";
