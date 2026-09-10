import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/github", () => ({
  gh: vi.fn(async () => ({ ok: true, json: async () => ({ sha: "deadbeefcafe0000" }) })),
  getFile: vi.fn(), putFile: vi.fn(), listTree: vi.fn(), repo: () => "owner/brain", branch: () => "main",
}));
vi.mock("../lib/access", () => ({ logNoteAccess: vi.fn() }));

import { logNoteAccess } from "../lib/access";
import { __setCache } from "../lib/corpus";
import { __setStore } from "../lib/mirror";
import { __setBubbleStore, type BubbleItem, type BubbleStore } from "../lib/bubble";
import { CONTEXT_BUDGET_BYTES, PROFILE_BUDGET_BYTES, RECENT_BUDGET_BYTES, getContext, previewContext } from "../lib/brain";

const access = vi.mocked(logNoteAccess);
const item = (over: Partial<BubbleItem> = {}): BubbleItem => ({
  id: 1, kind: "focus", project: "harbor", body: "working", status: "open", filed_into: "",
  surface: "terminal", touched_at: "2026-07-24T20:00:00Z", created_at: "2026-07-24T20:00:00Z", ...over,
});
function seed(files: Record<string, string>) {
  __setCache({ files: new Map(Object.entries(files)), sha: "deadbeefcafe0000", bytes: 0, fetchedAt: Date.now() });
}
function store(open: BubbleStore["open"]): BubbleStore {
  return { open, async add() { return item(); }, async update() { return null; }, async file() { return null; }, async drop() { return null; } };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-24T20:30:00Z"));
  __setCache(null); __setStore(null); __setBubbleStore(null); access.mockClear();
});
afterEach(() => {
  vi.useRealTimers(); __setCache(null); __setStore(undefined); __setBubbleStore(undefined);
});

describe("brain_context hard bounds and pure preview", () => {
  it.each(["Authorization: Bearer syntheticOpaqueCredential123","github_pat_syntheticOpaqueCredential123"])("masks recognized credentials in profile and working state before clipping: %s", async secret => {
    seed({"profile.md":`${"p".repeat(PROFILE_BUDGET_BYTES-10)} ${secret}`});
    __setBubbleStore(store(async()=>({items:[item({body:`Next step ${secret}`})],total:1,swept:0})));
    const preview=await previewContext();
    expect(preview.text).not.toContain("syntheticOpaqueCredential123");
    expect(preview.text).toMatch(/<redacted(?:-token)?>/);
    expect(preview.bytes).toBeLessThanOrEqual(CONTEXT_BUDGET_BYTES);
  });
  it("clips a growing multibyte profile explicitly and preserves the full-note route", async () => {
    const historicalMonths = Object.fromEntries(Array.from({ length: 400 }, (_, i) => {
      const year = 1900 + Math.floor(i / 12);
      const month = String((i % 12) + 1).padStart(2, "0");
      return [`log/${year}-${month}-01.md`, `# Log\n\n## 09:00 · harbor\n\nmonth ${i}`];
    }));
    seed({ "profile.md": "界😀e\u0301".repeat(10_000), ...historicalMonths });
    const preview = await previewContext();
    expect(preview.text).toContain("PROFILE HEAD ONLY");
    expect(preview.text).toContain("brain_read profile.md");
    expect(preview.profileBytes).toBeLessThanOrEqual(PROFILE_BUDGET_BYTES);
    expect(preview.bytes).toBeLessThanOrEqual(CONTEXT_BUDGET_BYTES);
    expect(preview.text).not.toContain("�");
  });

  it("does not log a preview but logs the paths genuinely served by getContext", async () => {
    seed({ "profile.md": "operator" });
    await previewContext();
    expect(access).not.toHaveBeenCalled();
    await getContext();
    expect(access).toHaveBeenCalledTimes(1);
    expect(access.mock.calls[0][0]).toContain("profile.md");
  });

  it("treats an expiry-only bubble notice as no usable working memory and expands logs", async () => {
    seed({ "profile.md": "P", "log/2026-07-24.md": "# Log\n\n## 09:00 · harbor\n\nVERBATIM STATE" });
    __setBubbleStore(store(async () => ({ items: [], total: 0, swept: 2 })));
    const preview = await previewContext();
    expect(preview.text).toContain("2 items just aged out");
    expect(preview.text).toContain("VERBATIM STATE");
  });

  it("requests scoped rows before the 200-item limit and honestly falls back on old deployments", async () => {
    seed({ "profile.md": "P", "log/2026-07-24.md": "# Log\n\n## 09:00 · harbor\n\nSCOPED LOG FALLBACK" });
    let scope: Parameters<BubbleStore["open"]>[0];
    __setBubbleStore(store(async (value) => { scope = value; throw new Error("bubble: POST rpc/bubble_open_scoped 404"); }));
    const preview = await previewContext(" Projects/HARBOR.md ");
    expect(scope).toEqual({ project: "harbor", includeGeneral: true });
    expect(preview.text).toContain("SCOPED LOG FALLBACK");
    expect(preview.text).toContain("bubble unavailable");
  });

  it("admits a same-day evening correction before an oversized older state", async () => {
    seed({
      "profile.md": "P",
      "log/2026-07-24.md": `# Log\n\n## 08:00 · harbor\n\nOLD ${"x".repeat(5_000)}\n\n## 20:00 · harbor\n\nEVENING CORRECTION`,
    });
    const preview = await previewContext("harbor");
    expect(preview.text).toContain("EVENING CORRECTION");
    expect(preview.text).not.toContain("OLD x");
  });

  it("bounds the complete recent section, including fences and digest notices", async () => {
    seed({
      "profile.md": "P",
      ...Object.fromEntries(Array.from({ length: 7 }, (_, i) => [
        `log/2026-07-${String(24 - i).padStart(2, "0")}.md`,
        `# Log\n\n## 09:00 · ${"界".repeat(100)}\n\n${"😀".repeat(900)}`,
      ])),
    });
    const preview = await previewContext();
    expect(preview.recentBytes).toBeLessThanOrEqual(RECENT_BUDGET_BYTES);
  });

  it("bounds the multibyte digest-only baseline and keeps omitted days discoverable", async () => {
    seed({
      "profile.md": "P",
      ...Object.fromEntries(Array.from({ length: 7 }, (_, i) => {
        const date = `2026-07-${String(24 - i).padStart(2, "0")}`;
        const tags = Array.from({ length: 8 }, (_, tag) => `${tag}${"界".repeat(39)}`).join(", ");
        return [`log/${date}.md`, `# Log\n\n## 09:00 · ${tags}\n\nstate`];
      })),
    });
    __setBubbleStore(store(async () => ({ items: [item()], total: 1, swept: 0 })));
    const preview = await previewContext();
    expect(preview.recentBytes).toBeLessThanOrEqual(RECENT_BUDGET_BYTES);
    expect(preview.text).toContain("day digests did not fit");
    expect(preview.text).toContain("brain_read log/2026-07-");
  });
});
