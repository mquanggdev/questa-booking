-- Puts one performance back to "nothing sold": run before each write
-- scenario so every benchmark starts from the same inventory.
--   psql -v perf=<performance id> -f reset-performance.sql
BEGIN;
DELETE FROM refunds WHERE payment_id IN (
  SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id
  WHERE o.performance_id = :'perf');
DELETE FROM payments WHERE order_id IN (
  SELECT id FROM orders WHERE performance_id = :'perf');
-- Phase 8: the orders' events and what the consumers made of them.
DELETE FROM processed_events WHERE event_id IN (
  SELECT e.id FROM outbox_events e JOIN orders o ON o.id = e.aggregate_id
  WHERE o.performance_id = :'perf');
DELETE FROM audit_logs WHERE entity = 'order' AND entity_id IN (
  SELECT id FROM orders WHERE performance_id = :'perf');
DELETE FROM outbox_events WHERE aggregate_id IN (
  SELECT id FROM orders WHERE performance_id = :'perf');
DELETE FROM performance_sales_stats WHERE performance_id = :'perf';
DELETE FROM orders WHERE performance_id = :'perf';  -- order_items, tickets cascade
UPDATE seats SET status = 'AVAILABLE' WHERE performance_id = :'perf';
UPDATE zones SET held_count = 0, sold_count = 0 WHERE performance_id = :'perf';
COMMIT;
