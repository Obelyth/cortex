import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { expect, it } from "vitest";
import { OverviewScreen, type OverviewProps } from "../app/s/[secret]/console/overview/overview-screen";
import { WorkingState } from "../app/s/[secret]/console/overview/working-state";
import { activity, checkedOut, dotField, pipeline } from "../lib/overview";

const now = Date.parse("2026-09-01T12:00:00Z");
const base: OverviewProps = {
  now, sha: "abcdef12", commitUrl: null, commitBase: null,
  notes: 0, retracted: 0, folders: 0, tokens: 0,
  served: null, mirror: null, boot: null, field: dotField([], 0),
  activity: activity({ rows: [], partial: false, since: now, covers: 0, durable: false, source: "unconfigured" }, now),
  reader: { current: "", options: [], writable: false, note: "No provider configured" },
  pipeline: pipeline(null, null, null, now), doors: [], saves: [],
  checked: checkedOut([], now), checkedWindow: "24 h", logWindow: "24 h",
};

function descendants(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap(child => isValidElement<Record<string, unknown>>(child)
    ? [child, ...descendants(child.props.children as ReactNode)] : []);
}

it("passes only the clock across Overview's working-state client boundary, never stored prose or projects", () => {
  const body = "password=synthetic-original-body-never-for-browser";
  const project = "token=synthetic-original-project";
  const props = { ...base, bubble: {
    total: 1, swept: 0, items: [{ id: 7, kind: "handoff", body, project, status: "open", filed_into: "", surface: "test", created_at: "2026-09-08", touched_at: "2026-09-08" }],
  } };
  const tree = OverviewScreen(props);
  const island = descendants(tree).find(child => child.type === WorkingState);
  expect(island).toBeDefined();
  // Assert serialized props, not visible text: unused client props still go into RSC.
  const payload = JSON.stringify(island!.props);
  expect(payload).not.toContain(body);
  expect(payload).not.toContain(project);
  expect(island!.props).toEqual({ now: base.now });
});
