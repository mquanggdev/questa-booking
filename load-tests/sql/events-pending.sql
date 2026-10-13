-- How much event work is still in flight for one performance: unpublished
-- outbox rows plus (event, consumer) pairs not applied yet. 0 = drained.
--   psql -At -v perf=<performance id> -f events-pending.sql
SELECT
  (SELECT count(*) FROM outbox_events e JOIN orders o ON o.id = e.aggregate_id
   WHERE o.performance_id = :'perf' AND e.published_at IS NULL)
+ (SELECT count(*) FROM outbox_events e JOIN orders o ON o.id = e.aggregate_id
   CROSS JOIN (VALUES ('notifications'), ('analytics'), ('audit')) c(name)
   WHERE o.performance_id = :'perf'
     AND NOT EXISTS (SELECT 1 FROM processed_events p
                     WHERE p.consumer = c.name AND p.event_id = e.id));
