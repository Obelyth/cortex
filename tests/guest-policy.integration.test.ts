import {createHash,randomUUID} from "node:crypto";
import {Redis} from "@upstash/redis";
import {afterEach,describe,it,expect,vi} from "vitest";
import {redisCommand} from "./helpers/redis-socket";
const socket=process.env.CORTEX_QUEUE_TEST_SOCKET;const keys:string[]=[];
afterEach(async()=>{if(socket)for(const key of keys.splice(0))await redisCommand(socket,"DEL",key);vi.doUnmock("../lib/kv");vi.resetModules();});
const policy={scope:["projects/","notes/a.md","notes/b.md"],citations:true,dailyAsks:12,maxK:3};
const sha1=(raw:string)=>createHash("sha1").update(raw).digest("hex");
async function fixture(raw?:string, reply:(raw:unknown)=>unknown=raw=>raw){
  const key=`cortex-final-guest-test:${randomUUID()}`;keys.push(key);
  if(raw!==undefined)await redisCommand(socket,"SET",key,raw);
  // Use the installed SDK's actual EVAL deserializer, with a fixed local-only transport.
  const client=new Redis({async request<T>({body}:{body?:unknown}):Promise<{result:T}>{
    if(!Array.isArray(body))throw new Error("unexpected command");
    const [command,...args]=body;
    let result:unknown;
    if(command==="eval"&&args[1]===1&&args[2]==="cortex:guest:synthetic"){
      result=reply(await redisCommand(socket,"EVAL",String(args[0]),1,key,...args.slice(3).map(String)));
    }else if(command==="get"&&/^cortex:guest:synthetic:asks:\d{4}-\d{2}-\d{2}$/.test(String(args[0]))){
      result=null;
    }else throw new Error("unexpected command");
    return{result:result as T};
  }});
  vi.doMock("../lib/kv",()=>({kvEnv:()=>"synthetic",kv:()=>client}));
  return{key,...await import("../lib/guest")};
}
// VISIBLE, not silent. A gated suite that skips itself shrinks the count and says nothing, so a
// run with no database looked identical to a run that had checked everything — for a month.
if (!process.env.CORTEX_QUEUE_TEST_SOCKET) {
  describe.skip("atomic guest policy through the real Upstash SDK and Valkey Lua — SKIPPED: set CORTEX_QUEUE_TEST_SOCKET to an absolute Valkey Unix socket path", () => {
    it("did not run", () => {});
  });
}
describe.skipIf(!socket)("atomic guest policy through the real Upstash SDK and Valkey Lua",()=>{
  it("reads and saves using exact stored-byte revisions",async()=>{
    const raw=`\n ${JSON.stringify(policy,null,2)} \n`;
    const {key,readGuestPolicy,writeGuestPolicy}=await fixture(raw);
    const current=await readGuestPolicy();
    expect(current).toMatchObject({...policy,source:"store",revision:sha1(raw)});
    const saved=await writeGuestPolicy({...policy,scope:["notes/a.md"]},current.revision!);
    expect(saved).toMatchObject({...policy,scope:["notes/a.md"]});
    expect(saved.revision).toBe(sha1(String(await redisCommand(socket,"GET",key))));
    expect(await readGuestPolicy()).toMatchObject({...saved,source:"store"});
  });
  it("distinguishes absence and returns a valid first-save receipt",async()=>{
    const {readGuestPolicy,writeGuestPolicy,GUEST_DEFAULTS}=await fixture();
    const missing=await readGuestPolicy();
    expect(missing).toMatchObject({...GUEST_DEFAULTS,source:"store",revision:sha1("cortex:guest:missing:v1")});
    const saved=await writeGuestPolicy(policy,missing.revision!);
    expect(saved).toMatchObject(policy);
    expect(await readGuestPolicy()).toMatchObject({...saved,source:"store"});
  });
  it("refuses two stale-tab replacements without resurrecting a removed grant",async()=>{
    const {readGuestPolicy,writeGuestPolicy}=await fixture(JSON.stringify(policy));
    const a=await readGuestPolicy(),b=await readGuestPolicy();
    const outcomes=await Promise.allSettled([
      writeGuestPolicy({...a,scope:["projects/","notes/b.md"]},a.revision!),
      writeGuestPolicy({...b,scope:["projects/","notes/a.md"]},b.revision!),
    ]);
    expect(outcomes.filter(o=>o.status==="fulfilled")).toHaveLength(1);
    expect(outcomes.filter(o=>o.status==="rejected")).toHaveLength(1);
    const current=await readGuestPolicy();expect(current.scope).toHaveLength(2);expect(current.citations).toBe(true);expect(current.dailyAsks).toBe(12);expect(current.maxK).toBe(3);
    await expect(writeGuestPolicy({...b,scope:[...b.scope,"notes/new.md"]},b.revision!)).rejects.toMatchObject({code:"conflict",current:{scope:current.scope,revision:current.revision}});
    expect((await readGuestPolicy()).scope).toEqual(current.scope);
  });
  it("conflicts on whitespace-only changes with current exact-byte revision",async()=>{
    const raw=JSON.stringify(policy);
    const {key,readGuestPolicy,writeGuestPolicy}=await fixture(raw);
    const before=await readGuestPolicy();
    const reformatted=` ${raw}\n`;
    await redisCommand(socket,"SET",key,reformatted);
    await expect(writeGuestPolicy({...policy,citations:false},before.revision!)).rejects.toMatchObject({code:"conflict",current:{...policy,revision:sha1(reformatted)}});
    expect(await redisCommand(socket,"GET",key)).toBe(reformatted);
  });
  it.each(["not-json","null","true","42","[]",'"{}"','""',""])("fails closed for nonobject storage %j",async raw=>{
    const {key,readGuestPolicy,writeGuestPolicy,requireReadablePolicy}=await fixture(raw);
    const current=await readGuestPolicy();
    expect(current).toMatchObject({source:"unreachable",revision:null,usedToday:null});
    expect(()=>requireReadablePolicy(current)).toThrow("door is closed");
    await expect(writeGuestPolicy(policy,"a".repeat(40))).rejects.toThrow("guest policy unavailable");
    expect(await redisCommand(socket,"GET",key)).toBe(raw);
  });
  it.each([
    ["unavailable"],
    ["unexpected",policy,"a".repeat(40)],
    ["saved",policy,"a".repeat(40)],
    ["conflict",policy,"a".repeat(40)],
    ["read",policy,"invalid-revision"],
  ])("rejects malformed or wrong read outcomes %#",async(...reply)=>{
    const {readGuestPolicy}=await fixture(JSON.stringify(policy),()=>reply);
    expect(await readGuestPolicy()).toMatchObject({source:"unreachable",revision:null});
  });
});
