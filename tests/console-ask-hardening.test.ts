import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const secret = "sk-synthetic-abcdefghijklmnopqrstuv";
const sentence = `The deployment credential is ${secret}.`;
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("fetch", () => { throw new Error("No network in reader hardening tests"); });
  vi.stubEnv("CONNECTOR_PATH_SECRET", "reader-test-secret");
  vi.stubEnv("CONSOLE_PASSCODE", "reader-test-passcode");
  vi.doMock("../lib/corpus", async original => ({ ...await original<object>(),
    loadCorpus: async () => ({ files: new Map([["projects/answer.md", `# ${secret}\n\n${sentence}`]]), sha: "a".repeat(40), bytes: 100, fetchedAt: 0 }),
  }));
  vi.doMock("../lib/settings", async original => ({ ...await original<object>(),
    readSettings: async () => ({}), safeActiveReader: async () => ({ active: { model: "claude-sonnet-5" } }),
  }));
});
afterEach(() => {
  for (const module of ["../lib/corpus", "../lib/settings", "../lib/reader"]) vi.doUnmock(module);
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules();
});

async function run(reply: (stable: string) => string) {
  vi.doMock("../lib/reader", () => ({ modelReader: async ({ stable }: { stable: string }) => reply(stable) }));
  const { stampValue } = await import("../lib/stamp");
  const { POST } = await import("../app/s/[secret]/console/ask/run/route");
  const response = await POST(new Request("https://reader.invalid/s/reader-test-secret/console/ask/run", {
    method: "POST", headers: { "Content-Type": "application/json", origin: "https://reader.invalid", cookie: `cortex-console=${stampValue()}` },
    body: JSON.stringify({ question: "deployment" }),
  }), { params: Promise.resolve({ secret: "reader-test-secret" }) });
  expect(response.status).toBe(200);
  return response.json();
}

describe("console reader output contract", () => {
  it("redacts structured answer, heading and evidence while preserving provenance", async () => {
    const result = await run(stable => JSON.stringify({ answer: sentence, quote: sentence,
      tag: stable.match(/FILE: projects\/answer\.md \[tag: ([a-z0-9]+)\]/)![1],
    }));
    expect(result.stamp).toBe("VERIFIED");
    expect(result.citation.path).toBe("projects/answer.md");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).toMatchObject({ protocol: "answer", coverage: { selectedNotes: 1, totalNotes: 1, complete: true } });
  });
  it("carries a protocol failure as UNVERIFIED with truthful metadata", async () => {
    const result = await run(() => "The deployment is ready");
    expect(result).toMatchObject({ stamp: "UNVERIFIED", protocol: "error", notInBrain: false });
  });
});
