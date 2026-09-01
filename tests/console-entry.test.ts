import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The console's front door as a two-step gate: the URL's secret proves the link, the passcode
 * proves the person, and only the pair mints the device stamp. What these tests hold is the
 * order of refusals — wrong secret learns nothing, a locked-out guess learns nothing, a wrong
 * passcode costs a metered failure — and that the stamp handed out is the derived HMAC, never
 * either raw credential.
 */

const fakeKv = vi.hoisted(() => {
  const state = {
    available: true,
    counts: new Map<string, number>(),
  };
  const client = {
    get: async (k: string) => state.counts.get(k) ?? null,
    pipeline: () => {
      const ops: Array<() => void> = [];
      const p = {
        incr: (k: string) => {
          ops.push(() => state.counts.set(k, (state.counts.get(k) ?? 0) + 1));
          return p;
        },
        expire: () => p,
        exec: async () => {
          for (const op of ops) op();
        },
      };
      return p;
    },
  };
  return { state, client };
});
vi.mock("../lib/kv", () => ({
  kv: () => (fakeKv.state.available ? fakeKv.client : null),
  kvEnv: () => "test",
}));

import { GET, POST } from "../app/s/[secret]/console/route";
import { STAMP_COOKIE, __setGateDelayForTests, stampValue } from "../lib/stamp";

const SECRET = "a".repeat(64);
const CODE = "the right passcode";
const failKey = (who: string) => `cortex:gate:fail:test:${who}`;

function get({ secret = SECRET, cookie }: { secret?: string; cookie?: string } = {}) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return GET(new Request(`https://cortex.test/s/${secret}/console`, { headers }), {
    params: Promise.resolve({ secret }),
  });
}

function post(
  passcode: string,
  {
    secret = SECRET,
    origin = null as string | null,
    address = "198.51.100.7",
    rawBody = undefined as string | undefined,
    contentType = "application/x-www-form-urlencoded",
  } = {},
) {
  const headers: Record<string, string> = {
    "content-type": contentType,
    "x-forwarded-for": address,
  };
  if (origin) headers.origin = origin;
  const req = new Request(`https://cortex.test/s/${secret}/console`, {
    method: "POST",
    headers,
    body: rawBody ?? `passcode=${encodeURIComponent(passcode)}`,
  });
  return POST(req, { params: Promise.resolve({ secret }) });
}

beforeEach(() => {
  vi.stubEnv("CONNECTOR_PATH_SECRET", SECRET);
  vi.stubEnv("CONSOLE_PASSCODE", CODE);
  fakeKv.state.available = true;
  fakeKv.state.counts.clear();
  __setGateDelayForTests(0);
});

describe("GET /s/<secret>/console", () => {
  it("404s empty on a wrong secret — no prompt ever confirms the path exists", async () => {
    const res = await get({ secret: "wrong" });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("shows the passcode prompt to an unstamped device, with nothing secret in the markup", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain('name="passcode"');
    expect(html).toContain('type="password"');
    // Relative action: the secret stays in the address bar, never in server-chosen markup.
    expect(html).toContain('action=""');
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain(CODE);
    expect(html).not.toContain(stampValue()!);
  });

  it("treats the pre-passcode cookie — the raw secret — as unstamped", async () => {
    const res = await get({ cookie: `${STAMP_COOKIE}=${SECRET}` });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('name="passcode"');
  });

  it("forwards a stamped device straight to the overview, renewing the stamp", async () => {
    const res = await get({ cookie: `${STAMP_COOKIE}=${stampValue()}` });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`/s/${SECRET}/console/overview`);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain(`${STAMP_COOKIE}=${stampValue()}`);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=31536000"]) {
      expect(cookie).toContain(attr);
    }
  });

  it("says CONSOLE LOCKED, with no form, while the passcode is unconfigured", async () => {
    vi.stubEnv("CONSOLE_PASSCODE", "");
    const res = await get();
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("CONSOLE_PASSCODE");
    expect(html).not.toContain('name="passcode"');
    expect(html).not.toContain(SECRET);
  });
});

describe("POST /s/<secret>/console", () => {
  it("404s empty on a wrong secret, right passcode or not", async () => {
    const res = await post(CODE, { secret: "wrong" });
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("mints the stamp on the right passcode — the derived value, not either credential", async () => {
    const res = await post(CODE);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/s/${SECRET}/console/overview`);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain(`${STAMP_COOKIE}=${stampValue()}`);
    expect(cookie).not.toContain(`=${SECRET}`);
    expect(cookie).not.toContain(CODE);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=31536000"]) {
      expect(cookie).toContain(attr);
    }
  });

  it("accepts a same-origin form and trims what was typed", async () => {
    const res = await post(`  ${CODE}  `, { origin: "https://cortex.test" });
    expect(res.status).toBe(303);
  });

  it("refuses a wrong passcode with 401, no cookie, and a metered failure", async () => {
    const res = await post("not it");
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toContain("wrong passcode");
    expect(fakeKv.state.counts.get(failKey("198.51.100.7"))).toBe(1);
    expect(fakeKv.state.counts.get(failKey("all"))).toBe(1);
  });

  it("refuses a cross-origin post outright — no guess is spent, nothing is metered", async () => {
    const res = await post(CODE, { origin: "https://evil.test" });
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(fakeKv.state.counts.size).toBe(0);
  });

  it("locks an address out after its failure budget, before the compare runs", async () => {
    fakeKv.state.counts.set(failKey("198.51.100.7"), 8);
    const res = await post(CODE);
    expect(res.status).toBe(429);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toContain("too many failed attempts");
  });

  it("locks everyone out past the global budget — rotating addresses buys nothing", async () => {
    fakeKv.state.counts.set(failKey("all"), 64);
    const res = await post(CODE, { address: "203.0.113.77" });
    expect(res.status).toBe(429);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("still answers a wrong passcode with 401 when the store is away — degrade, never throw", async () => {
    fakeKv.state.available = false;
    const res = await post("not it");
    expect(res.status).toBe(401);
  });

  it("400s a body that is not a form", async () => {
    const res = await post("", { rawBody: '{"passcode":"x"}', contentType: "application/json" });
    expect(res.status).toBe(400);
  });

  it("403s while the passcode is unconfigured — unset never becomes an open door", async () => {
    vi.stubEnv("CONSOLE_PASSCODE", "");
    const res = await post("");
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
