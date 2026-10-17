-- A partly received purchase order can be closed short when the rest will not be delivered.
ALTER TYPE "PurchaseOrderStatus" ADD VALUE 'CLOSED';
