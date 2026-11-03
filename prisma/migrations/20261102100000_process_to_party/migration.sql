-- Knitting and dyeing can deliver their fabric straight to a party (a customer) when they finish.
ALTER TYPE "ProcessDeliveryDestination" ADD VALUE IF NOT EXISTS 'PARTY';
