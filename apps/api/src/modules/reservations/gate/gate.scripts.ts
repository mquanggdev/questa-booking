import { LuaScript } from '../../../redis/lua-script.js';

// Key layout (all keys live in the default Redis database):
//   seat:hold:<seatId>     string, value = owner, TTL      (one per held seat)
//   zone:avail:<zoneId>    integer, tickets still sellable (one per standing zone)
//   zone:inflight:<zoneId> sorted set, owner -> ms         (holds not yet committed)
//   hold:req:<owner>       string, TTL                     (request in flight or committed)
// owner = "<userId>:<idempotencyKey>"

/**
 * Try to take every seat and standing ticket of one request, all or nothing.
 *
 * KEYS: reqKey, seat keys (n), avail keys (m), inflight keys (m)
 * ARGV: owner, pendingTtlMs, n, m, nowMs, quantity x m
 * Returns one of:
 *   {"OK"}                       applied; the caller must later commit or roll back
 *   {"DUPLICATE"}                same owner in flight or already committed; nothing applied
 *   {"SEATS_TAKEN", key, ...}    some seats are held by someone else
 *   {"SOLD_OUT", key, left}      a standing zone has too few tickets
 *   {"MISSING", key}             a standing counter is not initialised yet
 */
export const holdScript = new LuaScript(`
local owner = ARGV[1]
local ttl = tonumber(ARGV[2])
local n = tonumber(ARGV[3])
local m = tonumber(ARGV[4])
local now = tonumber(ARGV[5])

if redis.call('EXISTS', KEYS[1]) == 1 then
  return {'DUPLICATE'}
end

local taken = {}
for i = 1, n do
  local holder = redis.call('GET', KEYS[1 + i])
  if holder and holder ~= owner then
    table.insert(taken, KEYS[1 + i])
  end
end
if #taken > 0 then
  return {'SEATS_TAKEN', unpack(taken)}
end

for j = 1, m do
  local key = KEYS[1 + n + j]
  local left = redis.call('GET', key)
  if not left then
    return {'MISSING', key}
  end
  if tonumber(left) < tonumber(ARGV[5 + j]) then
    return {'SOLD_OUT', key, left}
  end
end

for i = 1, n do
  redis.call('SET', KEYS[1 + i], owner, 'PX', ttl)
end
for j = 1, m do
  redis.call('DECRBY', KEYS[1 + n + j], ARGV[5 + j])
  redis.call('ZADD', KEYS[1 + n + m + j], now, owner)
end
redis.call('SET', KEYS[1], '1', 'PX', ttl)
return {'OK'}
`);

/**
 * The database committed: keep the seat keys for the whole hold, forget the
 * in-flight markers, and keep the request marker for the whole hold too, so
 * a retry with the same Idempotency-Key is recognised as DUPLICATE and sent
 * to the database (which replays the order) instead of being counted twice.
 *
 * KEYS: reqKey, seat keys (n), inflight keys (m)
 * ARGV: owner, fullTtlMs, n, m
 */
export const commitScript = new LuaScript(`
local owner = ARGV[1]
local ttl = tonumber(ARGV[2])
local n = tonumber(ARGV[3])
local m = tonumber(ARGV[4])
for i = 1, n do
  if redis.call('GET', KEYS[1 + i]) == owner then
    redis.call('PEXPIRE', KEYS[1 + i], ttl)
  end
end
for j = 1, m do
  redis.call('ZREM', KEYS[1 + n + j], owner)
end
redis.call('SET', KEYS[1], 'committed', 'PX', ttl)
return 1
`);

/**
 * The database transaction failed: undo exactly what holdScript applied.
 *
 * KEYS: reqKey, seat keys (n), avail keys (m), inflight keys (m)
 * ARGV: owner, n, m, quantity x m
 */
export const rollbackScript = new LuaScript(`
local owner = ARGV[1]
local n = tonumber(ARGV[2])
local m = tonumber(ARGV[3])
for i = 1, n do
  if redis.call('GET', KEYS[1 + i]) == owner then
    redis.call('DEL', KEYS[1 + i])
  end
end
for j = 1, m do
  if redis.call('ZREM', KEYS[1 + n + m + j], owner) == 1 then
    redis.call('INCRBY', KEYS[1 + n + j], ARGV[3 + j])
  end
end
redis.call('DEL', KEYS[1])
return 1
`);

/**
 * An order was released in the database (expired or cancelled): free its
 * seats and give its standing tickets back. Counters that do not exist are
 * left alone; they are rebuilt from PostgreSQL on next use.
 *
 * KEYS: seat keys (n), avail keys (m)
 * ARGV: n, m, quantity x m
 */
export const releaseScript = new LuaScript(`
local n = tonumber(ARGV[1])
local m = tonumber(ARGV[2])
for i = 1, n do
  redis.call('DEL', KEYS[i])
end
for j = 1, m do
  if redis.call('EXISTS', KEYS[n + j]) == 1 then
    redis.call('INCRBY', KEYS[n + j], ARGV[2 + j])
  end
end
return 1
`);

/**
 * Set a standing counter to the value computed from PostgreSQL, but only when
 * no hold for that zone is in flight (otherwise the database value is about
 * to change and would be wrong). In-flight markers older than staleMs belong
 * to crashed requests and are dropped first.
 *
 * KEYS: avail key, inflight key
 * ARGV: databaseValue, nowMs, staleMs
 * Returns {"SET", old} | {"SAME"} | {"BUSY", inFlight}
 */
export const reconcileScript = new LuaScript(`
local value = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local stale = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - stale)
local busy = redis.call('ZCARD', KEYS[2])
if busy > 0 then
  return {'BUSY', tostring(busy)}
end
local current = redis.call('GET', KEYS[1])
if current and tonumber(current) == value then
  return {'SAME'}
end
redis.call('SET', KEYS[1], value)
return {'SET', tostring(current)}
`);
