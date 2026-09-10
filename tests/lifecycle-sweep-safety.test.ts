import { afterEach, describe, expect, it, vi } from "vitest";

type LifecycleModule = {
  main?: () => Promise<void>;
  isDirectRun?: (moduleUrl: string, argv1: string | undefined) => boolean;
  reportLifecycleError?: (error: unknown, write: (message: string) => void) => void;
};

async function loadModule(argv: string[] = []): Promise<Required<LifecycleModule>> {
  vi.stubEnv("SUPABASE_URL", "https://example.invalid");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-test-key");
  vi.resetModules();
  const previousArgv = process.argv;
  process.argv = [previousArgv[0], previousArgv[1], ...argv];
  const loaded = await import("../scripts/lifecycle-sweep") as LifecycleModule;
  process.argv = previousArgv;
  expect(typeof loaded.main).toBe("function");
  expect(typeof loaded.isDirectRun).toBe("function");
  expect(typeof loaded.reportLifecycleError).toBe("function");
  return loaded as Required<LifecycleModule>;
}

function syntheticFetch(scoreRows: unknown, candidates: unknown = []) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const body = url.includes("note_scores") ? scoreRows : candidates;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("lifecycle sweep response boundary", () => {
  it("rejects malformed score rows before formatting them", async () => {
    vi.stubGlobal("fetch", syntheticFetch([{ temperature: 7 }]));
    const { main } = await loadModule();

    await expect(main()).rejects.toThrow(/invalid score rows/);
  });

  it("neutralises forged lines and ANSI controls from synthetic API rows", async () => {
    vi.stubGlobal("fetch", syntheticFetch(
      [{ temperature: "hot" }],
      [{ path: "notes/good.md\nFORGED", reason: "\u001b[31mred\u001b[0m" }],
    ));
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));
    const { main } = await loadModule();

    await main();

    const output = logs.join("\n");
    expect(output).toContain("notes/good.md\\nFORGED — red");
    expect(output).not.toContain("notes/good.md\nFORGED");
    expect(output).not.toContain("\u001b");
  });

  it("recognises a direct entry path containing spaces without comparing an encoded URL by hand", async () => {
    vi.stubGlobal("fetch", syntheticFetch([]));
    const { isDirectRun } = await loadModule();

    expect(isDirectRun("file:///tmp/cortex%20scripts/lifecycle-sweep.ts", "/tmp/cortex scripts/lifecycle-sweep.ts")).toBe(true);
    expect(isDirectRun("file:///tmp/cortex%20scripts/lifecycle-sweep.ts", "/tmp/other.ts")).toBe(false);
    expect(isDirectRun("file:///tmp/cortex%20scripts/lifecycle-sweep.ts", undefined)).toBe(false);
  });

  it("rejects a malformed RPC count before it can reach a log line", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const body = String(input).includes("propose_deletions") ? "1\nFORGED\u001b[31m" : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const { main } = await loadModule(["--propose"]);

    await expect(main()).rejects.toThrow("propose_deletions returned an invalid count");
  });

  it("prints an accepted numeric RPC count without changing its value", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const body = String(input).includes("propose_deletions") ? 4 : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));
    const { main } = await loadModule(["--propose"]);

    await main();

    expect(logs[0]).toBe("propose_deletions(180) nominated 4 new note(s)");
  });

  it("keeps failed HTTP diagnostics but never carries the response body into the error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private\nFORGED\u001b[31m", { status: 503 })));
    const { main } = await loadModule();

    const error = await main().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("GET note_scores?select=temperature → 503");
    expect((error as Error).message).not.toContain("private");
  });

  it("neutralises CRLF and ANSI in the final CLI error sink", async () => {
    vi.stubGlobal("fetch", syntheticFetch([]));
    const { reportLifecycleError } = await loadModule();
    const errors: string[] = [];

    reportLifecycleError(new Error("offline\r\nFORGED\u001b[31mred\u001b[0m"), (message) => errors.push(message));

    expect(errors).toEqual(["offline\\r\\nFORGEDred"]);
  });
});
