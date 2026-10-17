WITH order_stats AS (
  SELECT
    sales_order."id",
    sales_order."status" AS current_status,
    COALESCE((
      SELECT SUM(item."quantityKg")
      FROM "SalesOrderItem" AS item
      WHERE item."salesOrderId" = sales_order."id"
    ), 0) AS ordered_kg,
    COALESCE((
      SELECT SUM(roll."netWeightKg")
      FROM "FinishedFabricRoll" AS roll
      JOIN "ProductionOrder" AS production ON production."id" = roll."productionOrderId"
      WHERE production."salesOrderId" = sales_order."id"
    ), 0) AS ready_kg,
    COALESCE((
      SELECT SUM(dispatch."totalWeightKg")
      FROM "Dispatch" AS dispatch
      WHERE dispatch."salesOrderId" = sales_order."id" AND dispatch."status" <> 'RETURNED'
    ), 0) AS dispatched_kg,
    COALESCE((
      SELECT SUM(delivery."receivedKg")
      FROM "Delivery" AS delivery
      JOIN "Dispatch" AS dispatch ON dispatch."id" = delivery."dispatchId"
      WHERE dispatch."salesOrderId" = sales_order."id"
    ), 0) AS delivered_kg,
    EXISTS (
      SELECT 1 FROM "ProductionOrder" AS production
      WHERE production."salesOrderId" = sales_order."id"
    ) AS has_production,
    EXISTS (
      SELECT 1 FROM "ProductionOrder" AS production
      WHERE production."salesOrderId" = sales_order."id"
        AND production."status" NOT IN ('PLANNED', 'WAITING')
    ) AS production_started,
    (
      EXISTS (
        SELECT 1 FROM "Invoice" AS invoice
        WHERE invoice."salesOrderId" = sales_order."id" AND invoice."status" <> 'CANCELLED'
      )
      AND COALESCE((
        SELECT SUM(invoice."taxableValue") FROM "Invoice" AS invoice
        WHERE invoice."salesOrderId" = sales_order."id" AND invoice."status" <> 'CANCELLED'
      ), 0) >= COALESCE((
        SELECT SUM(item."amount") FROM "SalesOrderItem" AS item
        WHERE item."salesOrderId" = sales_order."id"
      ), 0)
      AND NOT EXISTS (
        SELECT 1 FROM "Invoice" AS invoice
        WHERE invoice."salesOrderId" = sales_order."id"
          AND invoice."status" <> 'CANCELLED'
          AND COALESCE((
            SELECT SUM(payment."amount") FROM "CustomerPayment" AS payment
            WHERE payment."invoiceId" = invoice."id"
          ), 0) < invoice."totalAmount"
      )
    ) AS financially_settled
  FROM "SalesOrder" AS sales_order
)
UPDATE "SalesOrder" AS sales_order
SET "status" = CASE
  WHEN stats.current_status = 'CANCELLED' THEN 'CANCELLED'::"OrderStatus"
  WHEN stats.delivered_kg >= stats.ordered_kg - 0.01 AND stats.financially_settled THEN 'CLOSED'::"OrderStatus"
  WHEN stats.delivered_kg >= stats.ordered_kg - 0.01 THEN 'DELIVERED'::"OrderStatus"
  WHEN stats.delivered_kg > 0 THEN 'PARTIALLY_DELIVERED'::"OrderStatus"
  WHEN stats.dispatched_kg >= stats.ordered_kg - 0.01 THEN 'DISPATCHED'::"OrderStatus"
  WHEN stats.dispatched_kg > 0 THEN 'PARTIALLY_DISPATCHED'::"OrderStatus"
  WHEN stats.ready_kg >= stats.ordered_kg - 0.01 THEN 'READY'::"OrderStatus"
  WHEN stats.ready_kg > 0 THEN 'PARTIALLY_COMPLETED'::"OrderStatus"
  WHEN stats.production_started THEN 'IN_PRODUCTION'::"OrderStatus"
  WHEN stats.has_production THEN 'PLANNING'::"OrderStatus"
  WHEN stats.current_status = 'DRAFT' THEN 'DRAFT'::"OrderStatus"
  ELSE 'CONFIRMED'::"OrderStatus"
END
FROM order_stats AS stats
WHERE sales_order."id" = stats."id";
