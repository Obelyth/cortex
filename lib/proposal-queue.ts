/** One existing hash, one atomic script. Keeping the original key also preserves live legacy
 * rows. A zset adds no value to a 50-item queue: pruning this bounded hash avoids a migration
 * and orphaned expiry metadata. Already oversized legacy queues refuse admission until drained.
 *
 * ADMISSION RUNS THE PRUNE'S OWN TEST. The prune loop decodes every row with cjson and deletes
 * whatever fails; admit used to HSET the raw payload without decoding it. Anything cjson refuses
 * that JSON.stringify emits — a lone UTF-16 surrogate escape, from an emoji cut in half — was
 * acknowledged "Proposed" and deleted on the very next queue call, with nothing to say it had
 * ever been there. One predicate, applied at the door and on the sweep, so a row that is let in
 * is a row that survives. */
export const PROPOSAL_QUEUE_SCRIPT = `
local action, now, ttl, capacity, id, raw = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4]), ARGV[5], ARGV[6]
local function live(field, value)
  local valid, p = pcall(cjson.decode, value)
  valid = valid and type(p) == 'table' and p.id == field and type(p.ts) == 'number'
    and p.ts == p.ts and p.ts > -math.huge and p.ts < math.huge
    and type(p.path) == 'string' and type(p.content) == 'string'
    and (p.mode == 'create' or p.mode == 'replace' or p.mode == 'append')
    and (p.state == nil or p.state == 'pending' or p.state == 'accepting')
  return valid and (p.state == 'accepting' or p.ts + ttl > now)
end
local rows = redis.call('HGETALL', KEYS[1])
for i = 1, #rows, 2 do
  if not live(rows[i], rows[i+1]) then
    redis.call('HDEL', KEYS[1], rows[i])
  end
end
local value = redis.call('HGET', KEYS[1], id)
if action == 'admit' then
  if value then return {'collision'} end
  if not live(id, raw) then return {'invalid'} end
  if redis.call('HLEN', KEYS[1]) >= capacity then return {'full'} end
  redis.call('HSET', KEYS[1], id, raw)
  return {'ok'}
elseif action == 'list' then
  local result = {'ok'}
  local values = redis.call('HVALS', KEYS[1])
  for _, v in ipairs(values) do table.insert(result, v) end
  return result
elseif action == 'get' then
  if value then return {'ok', value} else return {'missing'} end
elseif action == 'claim' then
  if not value then return {'missing'} end
  local p = cjson.decode(value)
  if raw ~= '' then
    local valid, expected = pcall(cjson.decode, raw)
    if not valid or type(expected) ~= 'table' or p.id ~= expected.id or p.ts ~= expected.ts
      or p.path ~= expected.path or p.mode ~= expected.mode or p.content ~= expected.content then return {'conflict'} end
  end
  p.state = 'accepting'
  value = cjson.encode(p)
  redis.call('HSET', KEYS[1], id, value)
  return {'ok', value}
elseif action == 'reject' or action == 'finalize' then
  if not value then return {'missing'} end
  local p = cjson.decode(value)
  if action == 'reject' and p.state == 'accepting' then return {'conflict'} end
  if action == 'finalize' then
    local valid, expected = pcall(cjson.decode, raw)
    if not valid or type(expected) ~= 'table' or p.state ~= 'accepting'
      or p.id ~= expected.id or p.ts ~= expected.ts or p.path ~= expected.path
      or p.mode ~= expected.mode or p.content ~= expected.content then return {'conflict'} end
  end
  redis.call('HDEL', KEYS[1], id)
  return {'ok'}
end
return redis.error_reply('invalid proposal action')
`;
