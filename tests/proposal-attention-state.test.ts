import { Children, isValidElement, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
const proposals = vi.hoisted(() => vi.fn());
vi.mock("../lib/gate", () => ({ requireSecret: async () => {} }));
vi.mock("../app/s/[secret]/console/loaders", () => ({
  consoleProposals: proposals, consoleWatch: async () => [],
  consoleHealth: async () => ({ triage: [], totals: { retractedBlocks: 0 }, retractedList: [] }),
}));
import Attention from "../app/s/[secret]/console/attention/page";
import { ProposalsClient } from "../app/s/[secret]/console/attention/proposals-client";

function proposalKey(node: ReactNode): string | null | undefined {
  let key: string | null | undefined;
  Children.forEach(node, child => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return;
    if (child.type === ProposalsClient) key = child.key;
    else { const nested = proposalKey(child.props.children); if (nested !== undefined) key = nested; }
  });
  return key;
}
it("preserves the proposal client identity as the last queue row disappears, so its result survives refresh", async () => {
  proposals.mockResolvedValueOnce([{ id: "p1" }]).mockResolvedValueOnce([]);
  const withRows = await Attention({ params: Promise.resolve({ secret: "synthetic" }) });
  const withoutRows = await Attention({ params: Promise.resolve({ secret: "synthetic" }) });
  expect(proposalKey(withRows)).toBe("proposal-review");
  expect(proposalKey(withoutRows)).toBe("proposal-review");
});
