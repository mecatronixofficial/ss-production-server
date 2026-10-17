CREATE TABLE "ProcessingCompany" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "services" TEXT NOT NULL,
    "contactPerson" TEXT,
    "mobile" TEXT,
    "alternateMobile" TEXT,
    "email" TEXT,
    "gst" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "paymentTerms" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProcessingCompany_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProcessingCompany_code_key" ON "ProcessingCompany"("code");
CREATE INDEX "ProcessingCompany_active_name_idx" ON "ProcessingCompany"("active", "name");
