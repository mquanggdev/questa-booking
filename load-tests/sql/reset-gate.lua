-- Deletes the reservation gate's keys (seat holds, standing counters,
-- in-flight markers) so a load test starts from an empty gate. BullMQ's keys
-- (bull:*) are left alone: deleting them would drop the worker's schedules.
-- Counters are rebuilt from PostgreSQL on first use.
--   redis-cli EVAL "$(cat reset-gate.lua)" 0 'seat:hold:*' 'zone:*' 'hold:req:*'
local deleted = 0
for _, pattern in ipairs(ARGV) do
  local cursor = '0'
  repeat
    local page = redis.call('SCAN', cursor, 'MATCH', pattern, 'COUNT', 1000)
    cursor = page[1]
    for _, key in ipairs(page[2]) do
      deleted = deleted + redis.call('DEL', key)
    end
  until cursor == '0'
end
return deleted
