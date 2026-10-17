-- The Expense cancel columns were added to 20261011120000_money_management after it had already been applied,
-- so databases migrated before that edit never got them. IF NOT EXISTS keeps fresh databases (which do) working.

ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3);
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "cancelledById" TEXT;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "cancelReason" TEXT;
