-- A mill may have one purchasing account, reusing existing purchase receipts and payable reports.
ALTER TABLE "Supplier" ADD COLUMN "millId" TEXT;
CREATE UNIQUE INDEX "Supplier_millId_key" ON "Supplier"("millId");
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_millId_fkey" FOREIGN KEY ("millId") REFERENCES "Mill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
