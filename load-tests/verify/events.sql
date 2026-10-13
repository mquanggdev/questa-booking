-- Event invariants (phase 8), run after the payment scenarios once the
-- outbox has drained (load-tests/run.mjs waits for it). Prints one JSON object.
--   psql -At -v perf=<performance id> -f events.sql
--
-- I7: every PAID order has exactly one order.paid event, and each consumer
--     (notifications, analytics, audit) applied every event exactly once.
--     processed_events' primary key makes "more than once" impossible, so
--     what is checked is "at least once": no event left unapplied.
-- Also: one audit_logs row per event, and the analytics counters equal the
-- tickets of PAID orders.
WITH perf_orders AS (
  SELECT * FROM orders WHERE performance_id = :'perf'
),
perf_events AS (
  SELECT e.* FROM outbox_events e JOIN perf_orders o ON o.id = e.aggregate_id
),
consumers(name) AS (VALUES ('notifications'), ('analytics'), ('audit')),
paid_items AS (
  SELECT oi.* FROM order_items oi
  JOIN perf_orders o ON o.id = oi.order_id
  WHERE o.status = 'PAID' AND oi.released_at IS NULL
)
SELECT json_build_object(
  'events', (SELECT coalesce(json_object_agg(event_type, n), '{}') FROM
              (SELECT event_type, count(*) AS n FROM perf_events GROUP BY event_type) s),
  'unpublished', (SELECT count(*) FROM perf_events WHERE published_at IS NULL),
  'i7Violations',
    -- A PAID order without exactly one order.paid ...
    (SELECT count(*) FROM perf_orders o WHERE o.status = 'PAID'
       AND (SELECT count(*) FROM perf_events e
            WHERE e.aggregate_id = o.id AND e.event_type = 'order.paid') <> 1)
    -- ... an order.paid for an order that never became PAID ...
  + (SELECT count(*) FROM perf_events e JOIN perf_orders o ON o.id = e.aggregate_id
     WHERE e.event_type = 'order.paid'
       AND o.status NOT IN ('PAID', 'REFUND_PENDING', 'REFUNDED'))
    -- ... or an event some consumer has not applied.
  + (SELECT count(*) FROM perf_events e CROSS JOIN consumers c
     WHERE NOT EXISTS (SELECT 1 FROM processed_events p
                       WHERE p.consumer = c.name AND p.event_id = e.id)),
  'auditMismatch',
    (SELECT count(*) FROM perf_events)
  - (SELECT count(*) FROM audit_logs a JOIN perf_events e ON e.id = a.event_id),
  'statsMismatch',
    abs((SELECT coalesce(sum(tickets_sold), 0) FROM performance_sales_stats
         WHERE performance_id = :'perf')
      - (SELECT count(*) FROM paid_items))
);
