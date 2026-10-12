import { LuaScript } from '../../redis/lua-script.js';

/**
 * Join the line (ARGV[4] = '1') or only look (ARGV[4] = '0'). Atomic, so
 * two joins of the same person never get two numbers, and nobody is given
 * a number between the admitter reading the line and writing `served`.
 *
 * KEYS[1] line (sorted set), KEYS[2] meta (hash), KEYS[3] this person's
 * pass, KEYS[4] set of active performances.
 * ARGV[1] user id, ARGV[2] performance id, ARGV[3] key lifetime (s),
 * ARGV[4] join?
 *
 * Returns {state, a, served, waiting}: state ADMITTED with a = pass TTL in
 * ms, WAITING with a = number in line, NONE (not in line, nothing joined).
 */
export const joinScript = new LuaScript(`
local pttl = redis.call('PTTL', KEYS[3])
if pttl > 0 then return {'ADMITTED', pttl, 0, 0} end
local number = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not number then
  if ARGV[4] ~= '1' then
    local served = tonumber(redis.call('HGET', KEYS[2], 'served') or '0')
    return {'NONE', 0, served, redis.call('ZCARD', KEYS[1])}
  end
  number = redis.call('HINCRBY', KEYS[2], 'seq', 1)
  redis.call('ZADD', KEYS[1], number, ARGV[1])
  redis.call('SADD', KEYS[4], ARGV[2])
  redis.call('EXPIRE', KEYS[1], ARGV[3])
  redis.call('EXPIRE', KEYS[2], ARGV[3])
end
local served = tonumber(redis.call('HGET', KEYS[2], 'served') or '0')
return {'WAITING', tonumber(number), served, redis.call('ZCARD', KEYS[1])}
`);

/**
 * Admit the next ARGV[1] people: pop them from the line in arrival order,
 * give each a pass with a TTL, and record the last admitted number. A line
 * that becomes empty leaves the active set (a later join adds it back; both
 * are scripts, so they never interleave).
 *
 * KEYS[1] line, KEYS[2] meta, KEYS[3] active set.
 * ARGV[1] how many, ARGV[2] pass TTL (ms), ARGV[3] performance id,
 * ARGV[4] pass key prefix, ARGV[5] key lifetime (s).
 *
 * Returns {admitted user ids, served, waiting}.
 */
export const admitScript = new LuaScript(`
local popped = redis.call('ZPOPMIN', KEYS[1], ARGV[1])
local admitted = {}
for i = 1, #popped, 2 do
  redis.call('SET', ARGV[4] .. popped[i], '1', 'PX', ARGV[2])
  admitted[#admitted + 1] = popped[i]
end
if #popped > 0 then
  redis.call('HSET', KEYS[2], 'served', popped[#popped])
  redis.call('EXPIRE', KEYS[2], ARGV[5])
end
local waiting = redis.call('ZCARD', KEYS[1])
if waiting == 0 then redis.call('SREM', KEYS[3], ARGV[3]) end
local served = tonumber(redis.call('HGET', KEYS[2], 'served') or '0')
return {admitted, served, waiting}
`);
