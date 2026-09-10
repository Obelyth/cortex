import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {POST} from "../app/s/[secret]/console/ops/actions/route";
import {STAMP_COOKIE,stampValue} from "../lib/stamp";

const ctx={params:Promise.resolve({secret:"synthetic-secret"})};
const request=(body:ReadableStream<Uint8Array>)=>new Request("https://console.invalid/s/synthetic-secret/console/ops/actions",{method:"POST",headers:{"content-type":"application/json",origin:"https://console.invalid",cookie:`${STAMP_COOKIE}=${stampValue()}`},body,duplex:"half"} as RequestInit&{duplex:"half"});
beforeEach(()=>{vi.stubEnv("CONNECTOR_PATH_SECRET","synthetic-secret");vi.stubEnv("CONSOLE_PASSCODE","synthetic-passcode");});afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
it("stops reading an oversized action stream before allocation",async()=>{let pulls=0,cancelled=false;const stream=new ReadableStream<Uint8Array>({pull(c){pulls++;c.enqueue(new Uint8Array(5_000));if(pulls>5)c.close();},cancel(){cancelled=true;}});const res=await POST(request(stream),ctx);expect(res.status).toBe(413);expect(cancelled).toBe(true);expect(pulls).toBeLessThanOrEqual(3);});
it("bounds a stalled action body read",async()=>{vi.useFakeTimers();const stream=new ReadableStream<Uint8Array>({pull(){return new Promise(()=>{});}});const response=POST(request(stream),ctx);const sentinel=Symbol("still pending");const raced=Promise.race([response,new Promise<typeof sentinel>(resolve=>setTimeout(()=>resolve(sentinel),8_001))]);await vi.advanceTimersByTimeAsync(8_001);expect(await raced).not.toBe(sentinel);});
