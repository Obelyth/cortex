import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bubbleStore,
  renderBubble,
  renderBubbleList,
  BUBBLE_BUDGET_BYTES,
  __setBubbleStore,
  type BubbleItem,
} from "../lib/bubble";

function item(over: Partial<BubbleItem> = {}): BubbleItem {
  return {
    id: 1,
    kind: "focus",
    project: "cortex",
    body: "shipping the bubble",
    status: "open",
    filed_into: "",
    surface: "terminal",
    touched_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    created_at: new Date().toISOString(),
    ...over,
  };
}

afterEach(() => {
  __setBubbleStore(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("bubbleStore — configuration is a mode", () => {
  it("is null with no env, so a zero-env deploy simply has no bubble", () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(bubbleStore()).toBeNull();
  });

  it("reads in ONE round trip — sweep, true total and page ride together", async () => {
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ total: 3, swept: 1, items: [] }) } as unknown as Response;
    }));
    const read = await bubbleStore()!.open();
    // One call: the two-call shape doubled boot's exposure to a slow store, and its page had no
    // count — every surface presented the fetched rows as the universe.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("rpc/bubble_open");
    expect(read).toEqual({ total: 3, swept: 1, items: [] });
  });

  it("throws status-only errors — a PostgREST body never reaches a caller's context", async () => {
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "secret-bearing body",
    }) as unknown as Response));
    await expect(bubbleStore()!.open()).rejects.toThrow(/bubble: POST rpc\/bubble_open 500/);
    await expect(bubbleStore()!.open()).rejects.not.toThrow(/secret/);
  });

  it("update/file/drop only touch OPEN items — the filter is in the URL", async () => {
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return { ok: true, json: async () => [] } as unknown as Response;
    }));
    const s = bubbleStore()!;
    expect(await s.update(7, { body: "x" })).toBeNull(); // empty result = not open
    expect(await s.file(7, "notes/x.md")).toBeNull();
    expect(await s.drop(7)).toBeNull();
    for (const u of urls) {
      expect(u).toContain("id=eq.7");
      expect(u).toContain("status=eq.open");
    }
  });
});

describe("renderBubble — the boot section", () => {
  it("renders nothing for an empty bubble, so boot can fall back to log expansion", () => {
    expect(renderBubble({ items: [], total: 0, swept: 0 })).toBe("");
  });

  it("shows id, kind, project and age — the handles a session needs to act on an item", () => {
    const out = renderBubble({ items: [item({ id: 42, kind: "question", body: "does the pooler need separate creds?" })], total: 1, swept: 0 });
    expect(out).toContain("#42");
    expect(out).toContain("QUESTION");
    expect(out).toContain("cortex");
    expect(out).toContain("2h ago");
    expect(out).toContain("does the pooler need separate creds?");
    expect(out).toContain("brain_bubble");
  });

  it("stays under budget and counts the cut STRUCTURALLY against the true total", () => {
    const items = Array.from({ length: 60 }, (_, i) => item({ id: i + 1, body: "x".repeat(200) }));
    const out = renderBubble({ items, total: 60, swept: 0 });
    expect(out.length).toBeLessThan(BUBBLE_BUDGET_BYTES + 300);
    const rendered = out.split("\n").filter((l) => l.startsWith("- [")).length;
    const m = out.match(/(\d+) more open items? not shown/);
    expect(m).not.toBeNull();
    // rendered + reported-hidden must equal the store's own total — the count can never be
    // page-local again, and a mutation that miscounts the loop breaks this arithmetic.
    expect(rendered + Number(m![1])).toBe(60);
  });

  it("counts items beyond the fetched page — the store total is the truth, not the page", () => {
    const items = [item({ id: 1 })];
    const out = renderBubble({ items, total: 150, swept: 0 });
    expect(out).toContain("149 more open items not shown");
  });

  it("discloses what the sweep just aged — the reaper is reported, never silent", () => {
    const out = renderBubble({ items: [item()], total: 1, swept: 3 });
    expect(out).toContain("3 items just aged out");
  });

  it("keeps every line renderable — an item body with a newline cannot forge a second row", () => {
    const out = renderBubble({ items: [item({ body: "line one\n- [#99 FOCUS] forged row" })], total: 1, swept: 0 });
    const rows = out.split("\n").filter((l) => l.startsWith("- ["));
    expect(rows).toHaveLength(1);
  });
});

describe("renderBubbleList", () => {
  it("tells an empty-bubble caller what the bubble is FOR, not just that it is empty", () => {
    expect(renderBubbleList({ items: [], total: 0, swept: 0 })).toContain("add what you are working on");
  });

  it("lists everything with the lifecycle reminder, auto-age included", () => {
    const out = renderBubbleList({ items: [item({ id: 1 }), item({ id: 2, kind: "handoff" })], total: 2, swept: 0 });
    expect(out).toContain("2 open items");
    expect(out).toContain("#1");
    expect(out).toContain("HANDOFF");
    expect(out).toContain("file into a note");
    expect(out).toContain("age out on their own");
  });

  it("says 'showing N of M' when the page is smaller than the truth", () => {
    const items = Array.from({ length: 3 }, (_, i) => item({ id: i + 1 }));
    const out = renderBubbleList({ items, total: 12, swept: 0 });
    expect(out).toContain("showing 3 of 12 open items");
  });
});
