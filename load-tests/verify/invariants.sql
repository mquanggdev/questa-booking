-- Invariant checks run after every load test. Prints one JSON object.
--   psql -At -v perf=<performance id> -f invariants.sql
--
-- I1: a seat belongs to at most one active order.
-- I9: in a standing zone, held + sold <= capacity, and the counters match the
--     tickets actually issued (active order_items).
-- "Active" = order PENDING or PAID and the item not released.
WITH active AS (
  SELECT oi.order_id, oi.zone_id, oi.seat_id
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.performance_id = :'perf'
    AND o.status IN ('PENDING', 'PAID')
    AND oi.released_at IS NULL
),
seat_owners AS (
  SELECT seat_id, count(*) AS owners
  FROM active
  WHERE seat_id IS NOT NULL
  GROUP BY seat_id
),
standing AS (
  SELECT z.name, z.capacity, z.held_count, z.sold_count,
         (SELECT count(*) FROM active a WHERE a.zone_id = z.id) AS issued
  FROM zones z
  WHERE z.performance_id = :'perf' AND z.type = 'STANDING'
)
SELECT json_build_object(
  'seatsSold', (SELECT count(*) FROM seat_owners),
  'seatTickets', (SELECT coalesce(sum(owners), 0) FROM seat_owners),
  'i1DoubleSoldSeats', (SELECT count(*) FROM seat_owners WHERE owners > 1),
  'i1ExtraTickets', (SELECT coalesce(sum(owners - 1), 0) FROM seat_owners WHERE owners > 1),
  'i1MaxOwnersOfOneSeat', (SELECT coalesce(max(owners), 0) FROM seat_owners),
  'standing', coalesce((SELECT json_agg(json_build_object(
      'zone', name,
      'capacity', capacity,
      'counter', held_count + sold_count,
      'ticketsIssued', issued,
      'oversold', greatest(issued - capacity, 0),
      'lostUpdates', issued - (held_count + sold_count)
    )) FROM standing), '[]'::json),
  'i9Violations', (SELECT count(*) FROM standing
                   WHERE held_count + sold_count > capacity
                      OR issued > capacity
                      OR issued <> held_count + sold_count)
);
