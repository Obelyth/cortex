import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getContext } from "../lib/brain";
import { __setCache } from "../lib/corpus";
import { __setBubbleStore } from "../lib/bubble";
import type { BubbleItem } from "../lib/bubble";

/**
 * brain_context gained an optional `project`. What these tests hold is the contract of the scope:
 * the router (the index) stays complete, but the two cross-project tiers — recent log entries and
 * the working-state bubble — narrow to that project plus general items, so a session about one
 * thing is not handed another project's week. Unscoped is covered by brain.test.ts and must stay
 * byte-identical; here we prove the scoped path filters, keeps general items, and stays honest
 * when a project has no recent trail.
 */

function corpusOf(files: Record<string, string>) {
  __setCache({
    files: new Map(Object.entries(files)),
    sidecar: new Map(),
    sha: "deadbeefcafe0000",
    bytes: 0,
    fetchedAt: Date.now(),
  });
}

function item(over: Partial<BubbleItem> & Pick<BubbleItem, "id" | "project" | "body">): BubbleItem {
  return {
    kind: "focus",
    status: "open",
    filed_into: "",
    surface: "terminal",
    touched_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...over,
  };
}

function bubbleOf(items: BubbleItem[]) {
  __setBubbleStore({
    async open() {
      return { items, total: items.length, swept: 0 };
    },
    async add() {
      throw new Error("unused");
    },
    async update() {
      return null;
    },
    async file() {
      return null;
    },
    async drop() {
      return null;
    },
  });
}

// Invented notes only — the export gate forbids real brain paths in shipped source, and synthetic
// fixtures are the house style. harbor = the project in focus, pier = the other project whose week
// must not bleed in, galley = a mundane un-tracked topic.
const CORPUS = {
  "profile.md": "P",
  "notes/galley.md": "---\ndescription: dinners\n---\n# Meals",
  "projects/harbor.md": "---\ndescription: the harbor server\n---\n# Harbor",
  "projects/pier.md": "---\ndescription: pier ops\n---\n# Pier",
  "log/2026-07-24.md":
    "# Log\n\n## 09:00 · harbor, mcp\n\nharbor passcode work today\n\n## 14:00 · pier, audit\n\npier audit numbers\n\n## 16:00 · galley\n\nchili recipe notes",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-24T20:30:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  __setBubbleStore(undefined);
});

describe("brain_context scoped to a project", () => {
  it("keeps the router complete but narrows RECENT to the project's own entries", async () => {
    corpusOf(CORPUS);
    bubbleOf([]);
    const ctx = await getContext("harbor");

    // Router (index) is untouched — every note still has its row, whatever project it belongs to.
    expect(ctx).toContain("projects/pier.md");
    expect(ctx).toContain("notes/galley.md");

    // RECENT is scoped: the heading says so, the harbor entry rides, the others do not.
    expect(ctx).toContain("# RECENT (last 7 days · harbor)");
    expect(ctx).toContain("harbor passcode work today");
    expect(ctx).not.toContain("pier audit numbers");
    expect(ctx).not.toContain("chili recipe notes");
    expect(ctx).toContain("scoped to harbor");
  });

  it("shows this project's bubble items and the general ones, never another project's", async () => {
    corpusOf(CORPUS);
    bubbleOf([
      item({ id: 1, project: "harbor", body: "harbor phase in flight" }),
      item({ id: 2, project: "pier", body: "pier backlog item" }),
      item({ id: 3, project: "", body: "general reminder" }),
    ]);
    const ctx = await getContext("harbor");
    expect(ctx).toContain("# BUBBLE");
    expect(ctx).toContain("harbor phase in flight");
    expect(ctx).toContain("general reminder");
    expect(ctx).not.toContain("pier backlog item");
  });

  it("says so plainly when the project has no recent entries, rather than showing nothing", async () => {
    corpusOf(CORPUS);
    bubbleOf([]);
    const ctx = await getContext("lighthouse");
    expect(ctx).toContain("# RECENT (last 7 days · lighthouse)");
    expect(ctx).toContain("no entries in the last 7 days mention lighthouse");
    // And it did not leak another project's log text on the way.
    expect(ctx).not.toContain("harbor passcode work today");
    expect(ctx).not.toContain("pier audit numbers");
  });

  it("scopes the bubble even when a live bubble would otherwise elide the logs", async () => {
    // Unscoped, a live bubble replaces the raw log dump. Scoped, the point is the opposite: SHOW
    // this project's recent trail. So a scoped boot with a live bubble carries BOTH.
    corpusOf(CORPUS);
    bubbleOf([item({ id: 1, project: "harbor", body: "harbor phase in flight" })]);
    const ctx = await getContext("harbor");
    expect(ctx).toContain("harbor phase in flight");
    expect(ctx).toContain("harbor passcode work today");
    expect(ctx).toContain("# RECENT (last 7 days · harbor)");
  });

  it("an empty or whitespace project is treated as unscoped, not as a scope matching nothing", async () => {
    corpusOf(CORPUS);
    bubbleOf([]);
    const scoped = await getContext("   ");
    // Unscoped RECENT has no project suffix, and every project's entry is present verbatim.
    expect(scoped).toContain("# RECENT (last 7 days)");
    expect(scoped).not.toContain("· harbor)");
    expect(scoped).toContain("pier audit numbers");
    expect(scoped).toContain("chili recipe notes");
  });

  it("normalises a projects/…​.md argument down to the bare name", async () => {
    corpusOf(CORPUS);
    bubbleOf([]);
    const ctx = await getContext("projects/harbor.md");
    expect(ctx).toContain("# RECENT (last 7 days · harbor)");
    expect(ctx).toContain("harbor passcode work today");
  });
});
