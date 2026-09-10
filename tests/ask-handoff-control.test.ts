import { describe, expect, it, vi } from "vitest";
import type { HandoffPreview } from "../lib/handoff";
import { requestHandoffPreview } from "../lib/handoff-client";

const view: HandoffPreview = {
  project: "harbor",
  pagePath: "projects/harbor.md",
  sha: "deadbeefcafe",
  budgetBytes: 24_000,
  coverage: "handoff · harbor · included 1 of 1 candidate pieces",
  pieces: [{ kind: "page", label: "projects/harbor.md", why: "the project page", bytes: 120, included: true }],
  rankExcluded: [],
  rankExcludedTotal: 0,
  warnings: [],
  bubble: "absent",
  graph: "off",
};

describe("requestHandoffPreview", () => {
  it("posts the selected project to the authenticated no-log preview endpoint", async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(view), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await expect(requestHandoffPreview("/s/localdev/console/ask", "harbor", request)).resolves.toEqual(view);
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("/s/localdev/console/heat/handoff");
    if (!init) throw new Error("request init missing");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "harbor" }),
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports a failed preview without exposing endpoint error text", async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ error: "no project page" }), { status: 404 }));
    await expect(requestHandoffPreview("/s/localdev/console/ask", "missing", request)).rejects.toThrow();
  });

  it.each([
    ["truncated JSON", "{"],
    ["a malformed piece", JSON.stringify({ ...view, pieces: [{ ...view.pieces[0], bytes: "120" }] })],
  ])("rejects HTTP 200 %s so the control can offer retry", async (_case, body) => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await expect(requestHandoffPreview("/s/localdev/console/ask", "harbor", request)).rejects.toThrow();
  });
});
