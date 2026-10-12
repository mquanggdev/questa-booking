-- Before an on-sale run (after reset-performance.sql): the general sale
-- opens :lead seconds from now, and the waiting room is on or off.
--   psql -v perf=<id> -v lead=20 -v queue=true -f prepare-on-sale.sql
BEGIN;
UPDATE sale_phases
SET starts_at = now() + make_interval(secs => :'lead'::int)
WHERE performance_id = :'perf' AND type = 'GENERAL';
UPDATE performances
SET waiting_room_enabled = :'queue'::boolean
WHERE id = :'perf';
COMMIT;
