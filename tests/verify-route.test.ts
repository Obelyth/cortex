import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The inbox's verify endpoint, exercised as a route — the unit halves (lastVerified/stampVerified,
 * applyDecays/applyReverify) have their own suites; what THESE tests pin is the route's judgment:
 * which paths it refuses, which stamp it rewrites, and that the read half of its
 * read-modify-write is the RAW one.
 */
vi.mock("@/lib/brain", () => ({
  readNoteRaw: vi.fn(),
  writeNote: vi.fn(async () => ({ path: "x", commitSha: "a".repeat(40) })),
  validatePath: (p: string) => {
    if (!/^(profile\.md|(projects|notes|log)\/[\w.-]+\.md)$/.test(p)) throw new Error(`bad path: ${p}`);
  },
}));

import { POST } from "../app/s/[secret]/console/attention/verify/route";
import { STAMP_COOKIE, stampValue } from "../lib/stamp";
import { readNoteRaw, writeNote } from "@/lib/brain";

const SECRET = "route-test-secret";
const post = (body: unknown) =>
  POST(
    new Request("https://cortex.test/s/x/console/attention/verify", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", cookie: `${STAMP_COOKIE}=${stampValue()}` },
    }),
    { params: Promise.resolve({ secret: SECRET }) }
  );

beforeEach(() => {
  vi.stubEnv("CONNECTOR_PATH_SECRET", SECRET);
  vi.stubEnv("CONSOLE_PASSCODE", "verify-suite passcode");
  vi.mocked(readNoteRaw).mockReset();
  vi.mocked(writeNote).mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("attention/verify route", () => {
  it("refuses every action on a day log — a dated record is never on the clock", async () => {
    // It happened: a press on 2026-08-17 landed a `reverify:` block on log/2026-08-17.md —
    // frontmatter on a note that carries none by convention — breaking the router's description
    // invariant while the request went nowhere, because no check ever reads a day log.
    for (const action of ["checked", "settled", "queue"] as const) {
      const res = await post({ path: "log/2026-08-17.md", action });
      expect(res.status, action).toBe(400);
      expect((await res.json()).error).toMatch(/day log/);
    }
    expect(readNoteRaw).not.toHaveBeenCalled();
    expect(writeNote).not.toHaveBeenCalled();
  });

  it("'checked' rewrites the LAST stamp and leaves dated section stamps alone", async () => {
    const page =
      "## Early\n\n_Facts last verified 2026-08-01 — that section._\n\n" +
      "## Late\n\n_Facts last verified 2026-08-12 — the page's claim._\n";
    vi.mocked(readNoteRaw).mockResolvedValue(page);

    const res = await post({ path: "projects/harbor.md", action: "checked" });
    expect(res.status).toBe(200);
    const written = vi.mocked(writeNote).mock.calls[0][1] as string;
    expect(written).toContain("_Facts last verified 2026-08-01 — that section._");
    expect(written).not.toContain("2026-08-12");
    expect(vi.mocked(writeNote).mock.calls[0][2]).toBe("replace");
  });

  it("'settled' writes decays: false through the raw read — never the redacting one", async () => {
    // The read half of this read-modify-write MUST be readNoteRaw: reading through the egress
    // function saved `<redacted>` into a real page on 2026-08-17. The mock surface itself pins
    // this — the route imports readNoteRaw, and a regression to readNote would throw here.
    vi.mocked(readNoteRaw).mockResolvedValue("# Harbor\n\nbody\n");
    const res = await post({ path: "projects/harbor.md", action: "settled" });
    expect(res.status).toBe(200);
    expect(readNoteRaw).toHaveBeenCalledWith("projects/harbor.md");
    const written = vi.mocked(writeNote).mock.calls[0][1] as string;
    expect(written).toMatch(/^---\ndecays: false\n---/);
    expect(written).toContain("# Harbor\n\nbody");
  });

  it("'checked' on a page with no stamp refuses rather than inventing a claim", async () => {
    vi.mocked(readNoteRaw).mockResolvedValue("# Bare\n\nno stamp\n");
    const res = await post({ path: "notes/bare.md", action: "checked" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no "_Facts last verified_" stamp/);
    expect(writeNote).not.toHaveBeenCalled();
  });
});
