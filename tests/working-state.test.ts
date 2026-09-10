import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bubbleStore, __setBubbleStore } from "../lib/bubble";

const item = { id: 41, version: 1, kind: "handoff", project: "harbor", body: "Next: finish review", status: "open", filed_into: "", surface: "console", created_at: "2026-09-08T10:00:00Z", touched_at: "2026-09-08T10:00:00Z" };
const key = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
beforeEach(() => { __setBubbleStore(undefined); vi.stubEnv("SUPABASE_URL", "https://synthetic.invalid"); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic"); });
afterEach(() => { __setBubbleStore(undefined); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("working-state store contract", () => {
  it("sends add identity to the database and replays the current state", async () => {
    const requests: unknown[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ path: new URL(url).pathname, body: JSON.parse(String(init.body)) });
      return Response.json({ outcome: "saved", item: { ...item, version: 3, status: "filed" } });
    });
    const store = bubbleStore()!;
    expect(typeof store.change).toBe("function");
    const first = await store.change!({ action: "add", requestKey: key, kind: "handoff", body: item.body, project: "harbor" });
    const retry = await store.change!({ action: "add", requestKey: key, kind: "handoff", body: item.body, project: "harbor" });
    expect(first).toEqual(retry);
    expect(first).toMatchObject({ item: { id: 41, version: 3, status: "filed" } });
    expect(requests).toEqual(Array(2).fill({ path: "/rest/v1/rpc/bubble_console_add", body: { request_key: key, item_kind: "handoff", item_body: item.body, project_name: "harbor" } }));
  });
  it("passes the expected revision and omits an unchanged redacted body", async () => {
    let sent: unknown;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return Response.json({ outcome: "conflict", item: { ...item, version: 2 } }); });
    expect(typeof bubbleStore()!.change).toBe("function");
    await bubbleStore()!.change!({ action: "edit", id: 41, version: 1, kind: "decision", project: "harbor" });
    expect(sent).toEqual({ item_id: 41, expected_version: 1, item_kind: "decision", item_body: null, project_name: "harbor", age_out: false });
  });
});
