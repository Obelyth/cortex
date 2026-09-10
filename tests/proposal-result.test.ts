import { afterEach, expect, it, vi } from "vitest";
import { submitProposalDecision } from "../lib/proposal-result";
afterEach(() => vi.unstubAllGlobals());
it("renders a canceled winner truthfully even when the requested action was acceptance", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ ok: true, outcome: "canceled", path: "notes/a.md", commitSha: "cancel123", cleanupWarning: "queue unavailable" }));
  expect(await submitProposalDecision("/proposals", "p1", "accept")).toMatchObject({ success: true, message: expect.stringMatching(/Canceled.*cancel123.*queue unavailable/) });
});
it("a lost cancellation response does not claim that cancellation completed", async () => {
  vi.stubGlobal("fetch", async () => { throw new Error("lost response"); });
  expect(await submitProposalDecision("/proposals", "p1", "cancel")).toMatchObject({ success: false, message: expect.stringMatching(/committed or canceled.*same proposal id p1/) });
});
it("keeps a committed result and follow-up warnings visible after the row disappears", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ ok: true, outcome: "committed", path: "notes/a.md", commitSha: "abc", indexWarning: "index unavailable", cleanupWarning: "cleanup unavailable" }));
  expect(await submitProposalDecision("/proposals", "p1", "accept")).toEqual({ success: true, message: "Committed notes/a.md (commit abc). Index warning: index unavailable. Queue warning: cleanup unavailable." });
});
it.each(["network", "json"])("a lost %s response says the acceptance may have committed", async (failure) => {
  vi.stubGlobal("fetch", async () => { if (failure === "network") throw new Error("timeout"); return new Response("not JSON"); });
  expect(await submitProposalDecision("/proposals", "p1", "accept")).toMatchObject({ success: false, message: expect.stringMatching(/may already be committed.*same proposal id p1/) });
});
