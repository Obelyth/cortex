import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
import { ProposalsClient } from "../app/s/[secret]/console/attention/proposals-client";
import { ProposalLensBody } from "../app/s/[secret]/console/ops/ops-lens";

const p = { id: "abc", ts: 1, path: "notes/a.md", mode: "create" as const, content: "Synthetic proposal", state: "accepting" as const };
it("both proposal consoles expose cancellation for accepting work", () => {
  const attention = renderToStaticMarkup(createElement(ProposalsClient, { proposals: [p] }));
  const ops = renderToStaticMarkup(createElement(ProposalLensBody, { p, busy: false, error: null, onDecide: () => {} }));
  for (const html of [attention, ops]) {
    expect(html).toMatch(/Cancel acceptance/);
    expect(html).toMatch(/preserv|unchanged/);
  }
});
it("pending rejection remains available without advertising a cancellation commit", () => {
  const pending = { ...p, state: "pending" as const };
  const attention = renderToStaticMarkup(createElement(ProposalsClient, { proposals: [pending] }));
  const ops = renderToStaticMarkup(createElement(ProposalLensBody, { p: pending, busy: false, error: null, onDecide: () => {} }));
  for (const html of [attention, ops]) {
    expect(html).not.toMatch(/Cancel acceptance/);
    expect(html).toMatch(/[Rr]eject/);
  }
});
