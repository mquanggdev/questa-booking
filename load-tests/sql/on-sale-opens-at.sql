-- The general sale's opening, in epoch milliseconds (read after
-- prepare-on-sale.sql). Passed to k6 so buyers wait for the same instant.
SELECT (extract(epoch FROM starts_at) * 1000)::bigint
FROM sale_phases
WHERE performance_id = :'perf' AND type = 'GENERAL';
