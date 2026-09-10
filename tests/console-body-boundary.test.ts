import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
import {POST as settings} from "../app/s/[secret]/console/settings/save/route";
import {POST as proposals} from "../app/s/[secret]/console/proposals/route";
import {STAMP_COOKIE,stampValue} from "../lib/stamp";
const secret="s".repeat(64),ctx={params:Promise.resolve({secret})};
beforeEach(()=>{vi.stubEnv("CONNECTOR_PATH_SECRET",secret);vi.stubEnv("CONSOLE_PASSCODE","synthetic-console");});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
function request(body:BodyInit,origin="https://fixture.test",signed=true){return new Request("https://fixture.test/s/secret/console/action",{method:"POST",body,duplex:"half",headers:{origin,"content-type":"application/json",...(signed?{cookie:`${STAMP_COOKIE}=${stampValue()}`}:{})}} as RequestInit);}
describe.each([["settings",settings],["proposals",proposals]] as const)("%s shared streaming boundary",(_name,post)=>{
  it("refuses chunked overflow without Content-Length before allocating the full input",async()=>{
    let pulls=0,cancelled=false;const stream=new ReadableStream<Uint8Array>({pull(c){pulls++;c.enqueue(new TextEncoder().encode(" ".repeat(40000)));if(pulls===5){c.enqueue(new TextEncoder().encode("{}"));c.close();}},cancel(){cancelled=true;}});
    expect((await post(request(stream),ctx)).status).toBe(413);expect(pulls).toBeLessThan(5);expect(cancelled).toBe(true);
  });
  it("returns 408 for a never-ended body and checks authorization/origin before reads",async()=>{
    vi.useFakeTimers();let control!:ReadableStreamDefaultController<Uint8Array>,response:Response|undefined;
    const stream=new ReadableStream<Uint8Array>({start(c){control=c;}});
    void post(request(stream),ctx).then(r=>{response=r;});
    await vi.advanceTimersByTimeAsync(8001);
    try{expect(response?.status).toBe(408);}finally{try{control.close();}catch{}}
    expect((await post(request(new ReadableStream(),"https://fixture.test",false),ctx)).status).toBe(404);
    expect((await post(request(new ReadableStream(),"https://other.test"),ctx)).status).toBe(403);
  });
  it("refuses arrays and does not echo secret-shaped unknown keys",async()=>{
    expect((await post(request("[]"),ctx)).status).toBe(400);
    const r=await post(request(JSON.stringify({"Bearer synthetic-unknown-field":true})),ctx);
    expect(r.status).toBe(400);expect(await r.text()).not.toContain("synthetic-unknown-field");
  });
});
