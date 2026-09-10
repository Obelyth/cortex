import { beforeEach, expect, it, vi } from "vitest";
import { GET, POST } from "../app/s/[secret]/console/ops/devices/route";
import { STAMP_COOKIE, stampValue } from "../lib/stamp";
import { DEVICE_COOKIE, signDeviceCookie } from "../lib/device-cookie";

const id="bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
const item={id,label:"Synthetic phone",category:"phone",created_at:"2026-09-08T12:00:00.123456Z",updated_at:"2026-09-08T12:00:00.123456Z",last_seen_at:null};
const ctx={params:Promise.resolve({secret:"synthetic-secret"})};
let calls:{rpc:string;body:Record<string,unknown>}[];
beforeEach(()=>{
  calls=[];
  vi.stubEnv("CONNECTOR_PATH_SECRET","synthetic-secret");vi.stubEnv("CONSOLE_PASSCODE","synthetic-passcode");
  vi.stubEnv("SUPABASE_URL","https://synthetic.invalid");vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","synthetic-service");
  vi.stubGlobal("fetch",async(url:string,init:RequestInit)=>{
    const rpc=url.split("/").at(-1)!; const body=JSON.parse(String(init.body));calls.push({rpc,body});
    return Response.json(rpc==="console_device_list"?{items:[item]}:rpc==="console_device_forget"?{outcome:"forgotten",id}:rpc==="console_device_visit"?{outcome:"visited"}:{outcome:rpc==="console_device_rename"?"renamed":"registered",item:{...item,id:rpc==="console_device_register"?(body.current_id??body.request_key):id}});
  });
});
function request(body?:unknown,opts:{auth?:boolean;cookie?:string;origin?:string}={}) {
  return new Request("https://console.invalid/s/synthetic-secret/console/ops/devices",{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json",origin:opts.origin??"https://console.invalid",cookie:`${opts.auth===false?"":`${STAMP_COOKIE}=${stampValue()};`}${opts.cookie?`${DEVICE_COOKIE}=${opts.cookie}`:""}`},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
it("unregistered read lists independently without creating a row or cookie",async()=>{
  const res=await GET(request(),ctx),value=await res.json();
  expect(value.currentId).toBeNull();expect(value.items[0].label).toBe("Synthetic phone");expect(res.headers.get("set-cookie")).toBeNull();
  expect(calls.map(c=>c.rpc)).toEqual(["console_device_list"]);
});
it("prepares only explicitly and signed enrollment sends exact bounded SQL inputs",async()=>{
  const prep=await POST(request({action:"prepare"}),ctx);const prepared=await prep.json();
  expect(prepared.outcome).toBe("prepared");expect(calls).toEqual([]);
  const res=await POST(request({action:"register",intent:prepared.intent,label:" Synthetic phone ",category:"phone"}),ctx);
  expect(res.status).toBe(200);expect((await res.json()).item.updatedAt).toBe(item.updated_at);
  expect(calls[0].body).toMatchObject({chosen_label:"Synthetic phone",chosen_category:"phone",current_id:null});
  expect(calls[0].body.input_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(res.headers.get("set-cookie")).toContain("HttpOnly");
});
it("proves secret/stamp before inventory cookie parsing and refuses cross-origin or hidden visits",async()=>{
  expect((await GET(request(undefined,{auth:false,cookie:signDeviceCookie(id)}),ctx)).status).toBe(404);
  expect((await POST(request({action:"visit",visible:true},{cookie:signDeviceCookie(id),origin:"https://other.invalid"}),ctx)).status).toBe(403);
  expect((await POST(request({action:"visit",visible:false},{cookie:signDeviceCookie(id)}),ctx)).status).toBe(400);
  expect((await POST(request({action:"visit",visible:true}),{params:Promise.resolve({secret:"wrong"})})).status).toBe(404);
  expect(calls).toEqual([]);
});
it("tampered or absent cookie never enrolls or updates a visit",async()=>{
  for(const cookie of [undefined,signDeviceCookie(id)+"x"]){
    const res=await POST(request({action:"visit",visible:true},{cookie}),ctx);
    expect((await res.json()).outcome).toBe("unregistered");
    expect(res.headers.get("set-cookie")).toBeNull();
  }
  expect(calls).toEqual([]);
});
it("forgotten or expired old registration intents cannot clear an unrelated current binding",async()=>{
  const prepared=await (await POST(request({action:"prepare"}),ctx)).json();
  const cookie=signDeviceCookie(id);
  vi.stubGlobal("fetch",async()=>Response.json({outcome:"forgotten"}));
  const res=await POST(request({action:"register",intent:prepared.intent,label:"Other browser",category:null},{cookie}),ctx);
  expect((await res.json()).code).toBe("forgotten");expect(res.headers.get("set-cookie")).toBeNull();
  const expired=await POST(request({action:"register",intent:"expired-or-invalid",label:"Old browser",category:null},{cookie}),ctx);
  expect((await expired.json()).code).toBe("expired");expect(expired.headers.get("set-cookie")).toBeNull();
});
it("current identity comes only from verified cookie and forgetting it clears only inventory binding",async()=>{
  const cookie=signDeviceCookie(id);
  expect((await (await GET(request(undefined,{cookie}),ctx)).json()).currentId).toBe(id);
  const res=await POST(request({action:"forget",id,updatedAt:item.updated_at},{cookie}),ctx);
  expect((await res.json()).outcome).toBe("forgotten");expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(res.headers.get("set-cookie")).not.toContain(STAMP_COOKIE);
});
it("preserves microseconds for rename and rejects malformed success without claiming rollback",async()=>{
  const res=await POST(request({action:"rename",id,updatedAt:item.updated_at,label:"Renamed"}),ctx);
  expect(res.status).toBe(200);expect(calls[0].body.expected_updated).toBe("2026-09-08T12:00:00.123456Z");
  vi.stubGlobal("fetch",async()=>Response.json({outcome:"renamed",item:{id}}));
  const bad=await POST(request({action:"rename",id,updatedAt:item.updated_at,label:"Renamed"}),ctx);
  expect(bad.status).toBe(503);expect((await bad.json()).code).toBe("uncertain");
});
it("bounds inputs and hides provider details on unavailable inventory",async()=>{
  expect((await POST(request({action:"prepare",padding:"x".repeat(5000)}),ctx)).status).toBe(413);
  expect((await POST(request({action:"rename",id,updatedAt:item.updated_at,label:"password=synthetic-secret"}),ctx)).status).toBe(400);
  expect(calls).toEqual([]);
  vi.stubGlobal("fetch",async()=>Response.json({message:"password=raw-provider-secret"},{status:500}));
  const res=await GET(request(),ctx);expect(res.status).toBe(503);expect(await res.text()).not.toContain("raw-provider-secret");
});
it("does not bind a browser to a different identity from a malformed registration success",async()=>{
  const prepared=await (await POST(request({action:"prepare"}),ctx)).json();
  vi.stubGlobal("fetch",async()=>Response.json({outcome:"registered",item}));
  const res=await POST(request({action:"register",intent:prepared.intent,label:"Phone",category:"phone"}),ctx);
  expect(res.status).toBe(503);expect((await res.json()).code).toBe("uncertain");expect(res.headers.get("set-cookie")).toBeNull();
});
it("leaves cookies untouched when a passive roster observes a stale binding or fails",async()=>{
  const cookie=signDeviceCookie(id);
  vi.stubGlobal("fetch",async()=>Response.json({items:[]}));
  const res=await GET(request(undefined,{cookie}),ctx);expect(res.headers.get("set-cookie")).toBeNull();
  vi.stubGlobal("fetch",async()=>{throw new Error("unavailable");});
  expect((await GET(request(undefined,{cookie}),ctx)).headers.get("set-cookie")).toBeNull();
});
it.each(["GET","visit"])("a delayed stale %s response cannot erase a newer registration binding",async passive=>{
  let browserCookie=signDeviceCookie(id);
  const oldRequest=request(passive==="GET"?undefined:{action:"visit",visible:true},{cookie:browserCookie});
  const transport=vi.fn(async(url:string,init:RequestInit)=>{
    const body=JSON.parse(String(init.body));
    if(url.endsWith("console_device_list"))return Response.json({items:[]});
    if(url.endsWith("console_device_visit"))return Response.json({outcome:"missing"});
    return Response.json({outcome:"registered",item:{...item,id:body.request_key,label:"New browser"}});
  });
  vi.stubGlobal("fetch",transport);
  // Hold delivery of the old response. Its snapshot belongs to forgotten B.
  const delayed=passive==="GET"?await GET(oldRequest,ctx):await POST(oldRequest,ctx);
  const prepared=await (await POST(request({action:"prepare"}),ctx)).json();
  const registered=await POST(request({action:"register",intent:prepared.intent,label:"New browser",category:null}),ctx);
  expect(registered.status).toBe(200);
  const applyCookie=(res:Response)=>{
    const header=res.headers.get("set-cookie");
    if(header)browserCookie=header.split(";")[0].slice(`${DEVICE_COOKIE}=`.length);
  };
  applyCookie(registered);
  const newest=browserCookie;
  expect(newest).not.toBe(signDeviceCookie(id));
  // Delivery order is A's registration first, then B's older passive response.
  applyCookie(delayed);
  expect(browserCookie).toBe(newest);
  expect(delayed.headers.get("set-cookie")).toBeNull();
});
