-- Roles become SUPERADMIN / ADMIN / MANAGER / STAFF.
-- Existing managers ran the whole business, so they keep that access as ADMIN;
-- MANAGER is now a machines-only role. Workers become STAFF (godown only).
CREATE TYPE "Role_new" AS ENUM ('SUPERADMIN', 'ADMIN', 'MANAGER', 'STAFF');

ALTER TABLE "User" ALTER COLUMN "role" TYPE "Role_new" USING (
  CASE "role"::text
    WHEN 'MANAGER' THEN 'ADMIN'
    WHEN 'WORKER' THEN 'STAFF'
    ELSE "role"::text
  END
)::"Role_new";

DROP TYPE "Role";
ALTER TYPE "Role_new" RENAME TO "Role";
