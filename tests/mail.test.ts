import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { alertSubject, alertBody, mailer, __setMailer } from "../lib/mail";

const a = { unit: "groundskeeper", unitName: "Brain groundskeeper", from: "running", to: "crashed", error: "lease expired 09:34 with no finish", at: new Date("2026-09-02T09:34:00Z"), next: "read the run log, then Run now", boardUrl: "https://cortex.test/s/x/console/ops#groundskeeper" };

describe("alert text", () => {
  it.each([1495,1995])("redacts the complete credential before clipping at boundary %i",(padding)=>{
    const error="x ".repeat(padding)+"ghp_"+"a".repeat(40);
    expect(alertBody({...a,error})).not.toContain("ghp_");
  });
  it("subject names unit and transition", () => expect(alertSubject(a)).toBe("CORTEX OPS: Brain groundskeeper running → crashed"));
  it("body is four lines then the link", () => {
    const lines = alertBody(a).split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("What changed: Brain groundskeeper running → crashed");
    expect(lines[1]).toBe("Error: lease expired 09:34 with no finish");
    expect(lines[2]).toBe("When: 2026-09-02 09:34 UTC");
    expect(lines[3]).toBe("Next: read the run log, then Run now");
    expect(lines[4]).toBe(a.boardUrl);
  });
  it("prints a dash for a missing error", () => expect(alertBody({ ...a, error: null }).split("\n")[1]).toBe("Error: —"));
});

describe("mailer", () => {
  beforeEach(() => { __setMailer(undefined); vi.stubEnv("RESEND_API_KEY", "re_test"); vi.stubEnv("OPS_ALERT_TO", "k@example.com"); vi.stubEnv("OPS_ALERT_FROM", "Cortex <ops@cortex.example>"); });
  afterEach(() => { __setMailer(undefined); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  it("is null without env", () => { vi.stubEnv("RESEND_API_KEY", ""); expect(mailer()).toBeNull(); });
  it("POSTs to Resend with the bearer and returns the id", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ id: "m_1" }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const r = await mailer()!.send("s", "t");
    expect(r).toEqual({ ok: true, id: "m_1" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_test");
    expect(JSON.parse(init.body as string)).toMatchObject({ to: ["k@example.com"], subject: "s", text: "t" });
  });
  it("sends intact Unicode when subject and body field limits straddle an astral character",async()=>{
    let sent:any;
    vi.stubGlobal("fetch",async(_url:unknown,init?:RequestInit)=>{sent=JSON.parse(String(init?.body));return Response.json({id:"synthetic"});});
    const alert={...a,unitName:"n".repeat(487)+"😀",error:"e".repeat(2999)+"😀"};
    expect(await mailer()!.send(alertSubject(alert),alertBody(alert))).toMatchObject({ok:true});
    expect(sent.subject.isWellFormed()).toBe(true);expect(sent.text.isWellFormed()).toBe(true);
    expect(sent.subject.length).toBeLessThanOrEqual(500);
  });
  it("returns ok:false with the status on a 5xx, never throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 502 })));
    expect(await mailer()!.send("s", "t")).toMatchObject({ ok: false, status: 502 });
  });
  it("uses a frozen envelope and stable provider key rather than rotated destinations",async()=>{
    const f=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>Response.json({id:"accepted"}));vi.stubGlobal("fetch",f);
    await mailer()!.send("s","t",{key:"ops-alert/123",from:"original@example.com",to:"original-to@example.com"});
    const init=f.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe("ops-alert/123");
    expect(JSON.parse(String(init.body))).toMatchObject({from:"original@example.com",to:["original-to@example.com"]});
  });
  it("never exposes a thrown transport secret and distinguishes idempotency conflicts",async()=>{
    vi.stubGlobal("fetch",async()=>{throw new Error("Bearer private-secret "+"x".repeat(20000));});
    const failed=await mailer()!.send("s","t");
    expect(JSON.stringify(failed)).not.toContain("private-secret");
    expect(JSON.stringify(failed).length).toBeLessThan(300);
    vi.stubGlobal("fetch",async()=>Response.json({name:"invalid_idempotent_request",message:"secret"},{status:409}));
    expect(await mailer()!.send("s","t")).toMatchObject({ok:false,retryable:false});
    vi.stubGlobal("fetch",async()=>Response.json({name:"concurrent_idempotent_requests"},{status:409}));
    expect(await mailer()!.send("s","t")).toMatchObject({ok:false,retryable:true});
  });
  it("bounds outgoing and incoming bytes and refuses a send at the frozen cutoff",async()=>{
    const fetcher=vi.fn(async()=>new Response("x".repeat(4097)));vi.stubGlobal("fetch",fetcher);
    expect(await mailer()!.send("s","x".repeat(20001))).toMatchObject({ok:false,error:"request_too_large",retryable:false});
    expect(await mailer()!.send("s","t",{key:"stable",from:"a",to:"b",notAfter:Date.now()-1})).toMatchObject({ok:false,error:"provider_window_expired",retryable:false});
    expect(fetcher).not.toHaveBeenCalled();
    expect(await mailer()!.send("s","t")).toMatchObject({ok:false,error:"response_too_large",retryable:true});
    vi.stubGlobal("fetch",async()=>Response.json({id:42}));
    expect(await mailer()!.send("s","t")).toMatchObject({ok:false,error:"invalid_response"});
  });
});
