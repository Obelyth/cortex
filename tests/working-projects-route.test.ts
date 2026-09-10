import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STAMP_COOKIE, stampValue } from "../lib/stamp";

const corpus = vi.hoisted(() => ({ loadCorpus: vi.fn() }));
vi.mock("../lib/corpus", () => corpus);

import { GET } from "../app/s/[secret]/console/working-state/projects/route";

const secret = "synthetic-secret";
const ctx = { params: Promise.resolve({ secret }) };

function request(stamped = true) {
  return new Request(`https://console.invalid/s/${secret}/console/working-state/projects`, {
    headers: stamped ? { cookie: `${STAMP_COOKIE}=${stampValue()}` } : {},
  });
}

beforeEach(() => {
  vi.stubEnv("CONNECTOR_PATH_SECRET", secret);
  vi.stubEnv("CONSOLE_PASSCODE", "synthetic-passcode");
  corpus.loadCorpus.mockReset();
});

afterEach(() => vi.unstubAllEnvs());

describe("working-state project options route", () => {
  it.each([
    ["a missing device stamp", request(false), ctx],
    ["the wrong path secret", request(), { params: Promise.resolve({ secret: "wrong" }) }],
  ])("refuses %s before loading the corpus", async (_label, req, context) => {
    const response = await GET(req, context);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(corpus.loadCorpus).not.toHaveBeenCalled();
  });

  it("returns only unique, sorted canonical project page names", async () => {
    corpus.loadCorpus.mockResolvedValue({
      sha: "private-sha",
      files: new Map([
        ["projects/Kiln.MD", "private body"],
        ["projects/harbor.md", "password=body-must-never-leave"],
        ["projects/Harbor.md", "duplicate body"],
        ["projects/password=synthetic-hidden.md", "benign body"],
        ["projects/.md", "empty project"],
        [`projects/${"x".repeat(81)}.md`, "long project"],
        ["projects/archive/old.md", "nested non-project note"],
        ["notes/not-a-project.md", "not a project"],
      ]),
    });

    const response = await GET(request(), ctx);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(text)).toEqual({ projects: ["harbor", "kiln"], truncated: false });
    expect(text).not.toMatch(/private|password|synthetic-hidden|archive|private-sha/);
  });

  it("caps the sorted unique options and reports the omitted safe names", async () => {
    const files = new Map<string, string>();
    for (let i = 500; i >= 0; i--) files.set(`projects/project-${String(i).padStart(3, "0")}.md`, `body ${i}`);
    corpus.loadCorpus.mockResolvedValue({ sha: "private-sha", files });

    const response = await GET(request(), ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      projects: Array.from({ length: 500 }, (_, i) => `project-${String(i).padStart(3, "0")}`),
      truncated: true,
    });
  });

  it("checks secret-shaped names before normalization can disguise their casing", async () => {
    const credentialNames = [`AIza${"A".repeat(35)}`, `AKIA${"A".repeat(16)}`];
    corpus.loadCorpus.mockResolvedValue({ files: new Map([
      ...credentialNames.map(name => [`projects/${name}.md`, "synthetic fixture"] as const),
      ["projects/harbor.md", "safe project"],
    ]) });
    const response = await GET(request(), ctx);
    expect(await response.json()).toEqual({ projects: ["harbor"], truncated: false });
  });

  it("returns a fixed no-store failure without provider details", async () => {
    corpus.loadCorpus.mockRejectedValue(new Error("Authorization: Bearer syntheticOpaqueCredential123"));

    const response = await GET(request(), ctx);
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(text)).toEqual({ error: "project options unavailable" });
    expect(text).not.toContain("syntheticOpaqueCredential123");
  });
});
