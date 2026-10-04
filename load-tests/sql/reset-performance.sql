-- Puts one performance back to "nothing sold": run before each write
-- scenario so every benchmark starts from the same inventory.
--   psql -v perf=<performance id> -f reset-performance.sql
BEGIN;
DELETE FROM orders WHERE performance_id = :'perf';  -- order_items cascade
UPDATE seats SET status = 'AVAILABLE' WHERE performance_id = :'perf';
UPDATE zones SET held_count = 0, sold_count = 0 WHERE performance_id = :'perf';
COMMIT;
