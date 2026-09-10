import { describe, expect, it, vi } from "vitest";
import { defaultDiagnosticProbes, runDiagnostics, type DiagnosticProbe } from "../lib/console-diagnostics";

describe("bounded console diagnostics", () => {
  it("runs at most four probes concurrently and isolates individual failures", async () => {
    let active = 0, peak = 0;
    const probes: DiagnosticProbe[] = Array.from({ length: 7 }, (_, i) => ({
      name: `probe-${i}`,
      run: async () => {
        active++; peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        if (i === 2) throw new Error("credential=do-not-echo");
        return { state: "passed", detail: `observed 2026-09-08T18:00:00.000Z · result ${i}` };
      },
    }));
    const result = await runDiagnostics(probes, { concurrency: 4, deadlineMs: 1_000 });
    expect(peak).toBe(4);
    expect(result.checks).toHaveLength(7);
    expect(result.checks[2]).toEqual({ name: "probe-2", state: "failed", detail: "probe failed · see server log" });
    expect(JSON.stringify(result)).not.toContain("do-not-echo");
  });

  it("returns bounded unavailable results at the total deadline", async () => {
    vi.useFakeTimers();
    const resultPromise = runDiagnostics([
      { name: "fast", run: async () => ({ state: "passed", detail: "observed now" }) },
      { name: "hung", run: async () => new Promise(() => {}) },
    ], { concurrency: 2, deadlineMs: 30_000 });
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await resultPromise;
    expect(result.checks).toEqual([
      { name: "fast", state: "passed", detail: "observed now" },
      { name: "hung", state: "unavailable", detail: "diagnostic deadline reached" },
    ]);
    vi.useRealTimers();
  });

  it("labels runtime and corpus SHAs separately", async () => {
    const result = await runDiagnostics([
      { name: "source", run: async () => ({ state: "passed", detail: "observed 2026-09-08T18:00:00.000Z · runtime SHA 11111111 · corpus SHA 22222222" }) },
    ]);
    expect(result.checks[0].detail).toContain("runtime SHA 11111111 · corpus SHA 22222222");
  });
  it("catalogues every binding read-only diagnostic domain",()=>{
    expect(defaultDiagnosticProbes().map(probe=>probe.name)).toEqual([
      "dependency readiness","corpus coherence","mirror status","pending shipped migrations","settings and KV","reader configuration","relationships and answer cache",
    ]);
  });
  it("keeps unavailable stores and absent reader authority distinct without invoking a reader",async()=>{
    const now=()=>new Date("2026-09-08T18:00:00.000Z");
    const probes=defaultDiagnosticProbes(now,{
      health:vi.fn(async()=>({sha:"abcdef123456",totals:{notes:3,blocks:7,tokens:42}})) as never,
      mirror:vi.fn(async()=>({state:"off" as const,gitHead:"",mirrorHead:null,notes:null,syncedAt:null})),
      shippedMigrations:vi.fn(()=>["one.sql"]),appliedMigrations:vi.fn(async()=>null),
      settings:vi.fn(async()=>({defaultReader:null,disabledProviders:[],source:"unreachable" as const,conflicts:[]})),
      activeReader:vi.fn(async()=>({active:{model:"gpt-5.6-sol" as const,source:"built-in" as const},error:null})),
      relationshipStatus:vi.fn(async()=>"missing" as const),cacheStatus:vi.fn(async()=>"unavailable" as const),
    });
    const result=await runDiagnostics(probes,{deadlineMs:1_000});
    expect(result.checks.find(check=>check.name==="settings and KV")).toMatchObject({state:"unavailable",detail:expect.stringContaining("configured but settings could not be read")});
    expect(result.checks.find(check=>check.name==="reader configuration")).toMatchObject({state:"unavailable",detail:expect.stringContaining("credential missing")});
    expect(result.checks.find(check=>check.name==="relationships and answer cache")).toMatchObject({state:"unavailable",detail:expect.stringContaining("relationships missing · answer cache unavailable")});
    expect(JSON.stringify(result)).not.toContain("API_KEY");
  });
  it.each([
    [{ CORTEX_VERCEL_TOKEN: "synthetic", CORTEX_VERCEL_PROJECT_ID: "prj_synthetic" }, "Vercel configured yes"],
    [{ VERCEL_TOKEN: "synthetic", CORTEX_VERCEL_PROJECT_ID: "prj_synthetic" }, "Vercel configured no"],
    [{ CORTEX_VERCEL_TOKEN: "synthetic" }, "Vercel configured no"],
  ])("reads the adapter's own Vercel variables for readiness: %o → %s", async (env, expected) => {
    // The probe once read VERCEL_TOKEN, a name nothing else in the repo reads, so a deployment
    // configured exactly as docs/command-center-providers.md says answered "no".
    for (const name of ["VERCEL_TOKEN", "CORTEX_VERCEL_TOKEN", "CORTEX_VERCEL_PROJECT_ID"]) vi.stubEnv(name, "");
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const now = () => new Date("2026-09-08T18:00:00.000Z");
    const probes = defaultDiagnosticProbes(now, { health: vi.fn(async () => ({ sha: "abcdef123456", totals: { notes: 3, blocks: 7, tokens: 42 } })) as never });
    const readiness = probes.find((probe) => probe.name === "dependency readiness")!;
    expect((await readiness.run(AbortSignal.timeout(1_000))).detail).toContain(expected);
    vi.unstubAllEnvs();
  });
  it("labels a nonterminal empty cache page as a bounded sample, not proven emptiness",async()=>{
    const probe=defaultDiagnosticProbes(()=>new Date("2026-09-08T18:00:00.000Z"),{relationshipStatus:vi.fn(async()=>"current" as const),cacheStatus:vi.fn(async()=>"no-match-sampled" as const)}).at(-1)!;
    await expect(probe.run(AbortSignal.timeout(1_000))).resolves.toEqual({state:"skipped",detail:expect.stringContaining("answer cache no matching entry observed in bounded sample")});
  });
});
