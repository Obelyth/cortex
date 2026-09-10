import { afterEach, describe, expect, it, vi } from "vitest";
import type { HandoffPreview } from "../lib/handoff";
import { readProjectOptions, requestHandoffPreview } from "../lib/handoff-client";

const preview = (project = "harbor"): HandoffPreview => ({
  project,
  pagePath: `projects/${project}.md`,
  sha: "deadbeefcafe",
  budgetBytes: 24_000,
  coverage: `handoff · ${project} · included 1 of 1 candidate pieces`,
  pieces: [{ kind: "page", label: `projects/${project}.md`, why: "the project page", bytes: 120, included: true }],
  rankExcluded: [],
  rankExcludedTotal: 0,
  warnings: [],
  bubble: "absent",
  graph: "off",
});

afterEach(() => vi.unstubAllGlobals());

describe("requestHandoffPreview", () => {
  it("keeps a connector secret named console intact", async () => {
    const request = vi.fn(async () => Response.json(preview()));
    await requestHandoffPreview("/s/console/console/overview/", "harbor", request);
    expect(request).toHaveBeenCalledWith("/s/console/console/heat/handoff", expect.anything());
  });
  it("posts the canonical selected project with a bounded abort signal", async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(preview("harbor")));

    await expect(requestHandoffPreview("/s/synthetic/console/overview", " Projects/Harbor.MD ", request)).resolves.toEqual(preview("harbor"));

    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("/s/synthetic/console/heat/handoff");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "harbor" }),
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses an empty canonical project before starting a request", async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(preview()));

    await expect(requestHandoffPreview("/s/synthetic/console/overview", " projects/.md ", request)).rejects.toThrow("Select a project before previewing context.");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a valid preview for a different project", async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(preview("kiln")));

    await expect(requestHandoffPreview("/s/synthetic/console/overview", "harbor", request)).rejects.toThrow("malformed handoff preview: project did not match request");
  });

  it("does not expose response or provider error details", async () => {
    const responseFailure = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ error: "password=synthetic-hidden" }, { status: 503 }));
    await expect(requestHandoffPreview("/s/synthetic/console/overview", "harbor", responseFailure)).rejects.toThrow("preview failed (HTTP 503)");

    const providerFailure = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => { throw new Error("Authorization: Bearer syntheticOpaqueCredential123"); });
    await expect(requestHandoffPreview("/s/synthetic/console/overview", "harbor", providerFailure)).rejects.toThrow("Handoff preview is unavailable. Retry when the server returns.");
  });

  it("combines caller cancellation with its request deadline", async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const request = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      observed = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        observed?.addEventListener("abort", () => reject(observed?.reason), { once: true });
      });
    });

    const pending = requestHandoffPreview("/s/synthetic/console/overview", "harbor", request, controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow("Handoff preview was cancelled.");
    expect(observed?.aborted).toBe(true);
  });
});

describe("readProjectOptions", () => {
  it("parses route segments without matching text inside the secret", async () => {
    const request = vi.fn(async () => Response.json({ projects: [], truncated: false }));
    vi.stubGlobal("fetch", request);
    await readProjectOptions("/s/console/console/overview/");
    expect(request).toHaveBeenCalledWith("/s/console/console/working-state/projects", expect.anything());
  });
  it("reads the authenticated no-store endpoint with a bounded response DTO", async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ projects: ["harbor", "kiln"], truncated: false }));
    vi.stubGlobal("fetch", request);

    await expect(readProjectOptions("/s/synthetic/console/overview")).resolves.toEqual({ projects: ["harbor", "kiln"], truncated: false });

    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("/s/synthetic/console/working-state/projects");
    expect(init).toMatchObject({ cache: "no-store" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["too many projects", { projects: Array.from({ length: 501 }, (_, i) => `p-${i}`), truncated: true }],
    ["an unbounded project", { projects: ["x".repeat(81)], truncated: false }],
    ["an uncanonical project", { projects: ["Projects/Harbor.md"], truncated: false }],
    ["duplicate projects", { projects: ["harbor", "harbor"], truncated: false }],
    ["unsorted projects", { projects: ["kiln", "harbor"], truncated: false }],
    ["a non-boolean truncation marker", { projects: ["harbor"], truncated: "false" }],
  ])("rejects %s in the project options DTO", async (_label, body) => {
    vi.stubGlobal("fetch", async () => Response.json(body));
    await expect(readProjectOptions("/s/synthetic/console/overview")).rejects.toThrow("Project options returned an invalid response.");
  });

  it("does not expose response or provider error details", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ error: "github_pat_syntheticOpaqueCredential123" }, { status: 503 }));
    await expect(readProjectOptions("/s/synthetic/console/overview")).rejects.toThrow("Project options are unavailable (HTTP 503).");

    vi.stubGlobal("fetch", async () => { throw new Error("password=synthetic-hidden"); });
    await expect(readProjectOptions("/s/synthetic/console/overview")).rejects.toThrow("Project options are unavailable. Retry when the server returns.");
  });
});
