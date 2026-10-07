-- Puts one performance back to "nothing sold": run before each write
-- scenario so every benchmark starts from the same inventory.
--   psql -v perf=<performance id> -f reset-performance.sql
BEGIN;
DELETE FROM refunds WHERE payment_id IN (
  SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id
  WHERE o.performance_id = :'perf');
DELETE FROM payments WHERE order_id IN (
  SELECT id FROM orders WHERE performance_id = :'perf');
DELETE FROM orders WHERE performance_id = :'perf';  -- order_items, tickets cascade
UPDATE seats SET status = 'AVAILABLE' WHERE performance_id = :'perf';
UPDATE zones SET held_count = 0, sold_count = 0 WHERE performance_id = :'perf';
COMMIT;
