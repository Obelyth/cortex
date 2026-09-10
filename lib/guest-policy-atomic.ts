/** One existing policy key. Revisions identify exact bytes, not users or elapsed time. */
export const GUEST_POLICY_SCRIPT = `
if redis.call('STRLEN',KEYS[1])>65536 then return {'unavailable'} end
local raw=redis.call('GET',KEYS[1])
local revision=redis.sha1hex(raw or 'cortex:guest:missing:v1')
if ARGV[1]=='read' then return {'read',raw or '',revision} end
if ARGV[1]~='write' or #ARGV[3]>65536 then return {'unavailable'} end
if ARGV[2]~=revision then return {'conflict',raw or '',revision} end
redis.call('SET',KEYS[1],ARGV[3])
return {'saved',ARGV[3],redis.sha1hex(ARGV[3])}
`;
