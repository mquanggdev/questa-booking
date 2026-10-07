-- Payment invariants, run after the full-flow, webhook-chaos and check-in
-- scenarios. Prints one JSON object.
--   psql -At -v perf=<performance id> -f payments.sql
--
-- I2:  SOLD seats are exactly the active seats of PAID orders, and every
--      active item of a PAID order has one valid ticket.
-- I4:  every gateway transaction settled at most one payment, and an order
--      is fulfilled by one payment; any extra money has a refund.
-- I8:  money received for an order that is not PAID always has a refund.
-- I12: a PAID order was paid with exactly its total_amount.
-- I6 is checked by load-tests/run.mjs: accepted scans = checked-in tickets.
WITH perf_orders AS (
  SELECT * FROM orders WHERE performance_id = :'perf'
),
paid_items AS (
  SELECT oi.* FROM order_items oi
  JOIN perf_orders o ON o.id = oi.order_id
  WHERE o.status = 'PAID' AND oi.released_at IS NULL
),
succeeded AS (
  SELECT p.*, o.status AS order_status, o.total_amount,
         EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id = p.id) AS refunded
  FROM payments p
  JOIN perf_orders o ON o.id = p.order_id
  WHERE p.status = 'SUCCEEDED'
),
kept AS (
  -- Money the business keeps, per order: succeeded payments without a refund.
  SELECT order_id, count(*) AS n, min(order_status::text) AS order_status
  FROM succeeded WHERE NOT refunded GROUP BY order_id
)
SELECT json_build_object(
  'orders', (SELECT coalesce(json_object_agg(status, n), '{}') FROM
              (SELECT status, count(*) AS n FROM perf_orders GROUP BY status) s),
  'payments', (SELECT coalesce(json_object_agg(status, n), '{}') FROM
              (SELECT p.status, count(*) AS n FROM payments p
               JOIN perf_orders o ON o.id = p.order_id GROUP BY p.status) s),
  'refunds', (SELECT coalesce(json_object_agg(status, n), '{}') FROM
              (SELECT r.status, count(*) AS n FROM refunds r
               JOIN payments p ON p.id = r.payment_id
               JOIN perf_orders o ON o.id = p.order_id GROUP BY r.status) s),
  'ticketsValid', (SELECT count(*) FROM tickets t JOIN paid_items i ON i.id = t.order_item_id
                   WHERE t.voided_at IS NULL),
  'ticketsCheckedIn', (SELECT count(*) FROM tickets t
                       JOIN order_items oi ON oi.id = t.order_item_id
                       JOIN perf_orders o ON o.id = oi.order_id
                       WHERE t.checked_in_at IS NOT NULL),
  'i2Violations',
    (SELECT count(*) FROM seats s WHERE s.performance_id = :'perf' AND s.status = 'SOLD'
       AND NOT EXISTS (SELECT 1 FROM paid_items i WHERE i.seat_id = s.id))
  + (SELECT count(*) FROM paid_items i JOIN seats s ON s.id = i.seat_id WHERE s.status <> 'SOLD')
  + (SELECT count(*) FROM paid_items i WHERE NOT EXISTS (
       SELECT 1 FROM tickets t WHERE t.order_item_id = i.id AND t.voided_at IS NULL)),
  'i4Violations',
    (SELECT count(*) FROM (SELECT provider_txn_id FROM succeeded
       GROUP BY provider_txn_id HAVING count(*) > 1) d)
  + (SELECT count(*) FROM kept WHERE n > 1),
  'i8Violations', (SELECT count(*) FROM kept WHERE order_status <> 'PAID'),
  'i12Violations',
    (SELECT count(*) FROM perf_orders o WHERE o.status = 'PAID' AND NOT EXISTS (
       SELECT 1 FROM succeeded s WHERE s.order_id = o.id AND s.amount = o.total_amount))
  + (SELECT count(*) FROM succeeded WHERE amount <> total_amount)
);
