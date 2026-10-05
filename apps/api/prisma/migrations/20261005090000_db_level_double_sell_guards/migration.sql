-- Phase 3: let the database itself refuse to double-sell.
--
-- Development databases may contain phase 2 data that already violates the
-- new rules (seats sold twice, oversold standing zones). Such rows are
-- repaired first, otherwise the guards below could not be created.

-- 1. Idempotency: one order per (user, Idempotency-Key).
ALTER TABLE "orders"
  ADD COLUMN "idempotency_key" TEXT,
  ADD COLUMN "request_hash" TEXT;

-- Existing orders never had a key; give each a unique placeholder.
UPDATE "orders"
SET "idempotency_key" = 'legacy-' || "id"::text,
    "request_hash" = ''
WHERE "idempotency_key" IS NULL;

ALTER TABLE "orders"
  ALTER COLUMN "idempotency_key" SET NOT NULL,
  ALTER COLUMN "request_hash" SET NOT NULL;

CREATE UNIQUE INDEX "orders_user_id_idempotency_key_key"
  ON "orders"("user_id", "idempotency_key");

-- 2. Repair: a seat held by more than one active order item keeps the
-- oldest one; the others are released and their orders cancelled.
WITH ranked AS (
  SELECT oi.id, oi.order_id,
         row_number() OVER (PARTITION BY oi.seat_id ORDER BY o.created_at, oi.id) AS rn
  FROM "order_items" oi
  JOIN "orders" o ON o.id = oi.order_id
  WHERE oi.seat_id IS NOT NULL AND oi.released_at IS NULL
),
released AS (
  UPDATE "order_items" oi
  SET "released_at" = now()
  FROM ranked r
  WHERE oi.id = r.id AND r.rn > 1
  RETURNING oi.order_id
)
UPDATE "orders"
SET "status" = 'CANCELLED', "updated_at" = now()
WHERE "id" IN (SELECT order_id FROM released) AND "status" = 'PENDING';

-- I1: a seat belongs to at most one active order. Partial: released items
-- (expired, cancelled, refunded orders) no longer occupy the seat.
CREATE UNIQUE INDEX "order_items_active_seat_key"
  ON "order_items"("seat_id")
  WHERE "seat_id" IS NOT NULL AND "released_at" IS NULL;

-- 3. Repair counters that phase 2 pushed past capacity.
UPDATE "zones"
SET "held_count" = GREATEST("capacity" - "sold_count", 0)
WHERE "held_count" + "sold_count" > "capacity";

-- I9: a zone never holds and sells more than its capacity. Last line of
-- defence: the application's conditional UPDATE should never reach it.
ALTER TABLE "zones"
  ADD CONSTRAINT "zones_within_capacity" CHECK ("held_count" + "sold_count" <= "capacity");
