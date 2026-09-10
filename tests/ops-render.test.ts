import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildBoard } from "../lib/ops-board";
import { decisionItems } from "../lib/ops-inbox";
import type { Run, Unit } from "../lib/ops-state";
import type { OpsEvent } from "../lib/ops";

// The register and the Decisions panel are client components that read the router and the
// lens; under the server render Next performs they see the shell's provider and a router that
// does nothing, which is what these stand in for.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {}, replace() {} }), usePathname: () => "/s/localdev/console/ops" }));

const { LensProvider } = await import("../app/s/[secret]/console/lens");
const { OpsScreen } = await import("../app/s/[secret]/console/ops/ops-screen");
const { OpsDecisions } = await import("../app/s/[secret]/console/ops/ops-decisions");

/**
 * The Ops screen's server render, from fixtures — the markup the browser receives before any
 * script runs. The v2 port moved the unit's controls into the lens, which opens on a click, so
 * the page must be honest and complete without one: every unit on the register, its state in
 * words, the receipts with their days, the strip's window on every figure.
 */
const T0 = new Date("2026-09-05T08:40:00Z");
const base: Omit<Unit, "id" | "name" | "kind" | "owner"> = { period_s: 86400, grace_s: 1800, max_run_s: 1200, pages: true, tolerance: 1, paused_until: null, run_now: null, notes: null };
const units: Unit[] = [
  { ...base, id: "console-secret", name: "Console secret", kind: "item", owner: "manager", period_s: null },
  { ...base, id: "groundskeeper", name: "Brain groundskeeper", kind: "routine", owner: "manager", run_now: { kind: "dispatch", target: "run-groundskeeper" } },
];
const done: Run = { id: 41, unit_id: "groundskeeper", run_key: "2026-09-04", trigger: "cron", scheduled_at: null, started_at: "2026-09-04T09:17:00Z", ended_at: "2026-09-04T09:31:12Z", lease_until: null, state: "succeeded", exit_reason: null, attempt: 1, summary: "3 stamps refreshed", error: null, evidence: ["https://github.com/example/brain/commit/8be1c5c0"], cost: null, facts: null };
const events: OpsEvent[] = [
  { id: 118, unit_id: "console-secret", run_id: null, at: "2026-09-05T07:15:00Z", actor: "unit", kind: "transition", body: {}, from_state: "scheduled", to_state: "needs_you" },
  { id: 117, unit_id: "groundskeeper", run_id: null, at: "2026-09-04T09:31:12Z", actor: "unit", kind: "finish", body: { summary: "3 stamps refreshed", evidence: ["https://github.com/example/brain/commit/8be1c5c0"] } },
];
const board = buildBoard(units, new Map([["groundskeeper", done]]), new Map(), new Map(), events, T0);
const items = decisionItems([{ sev: "warn", kind: "stale-stamp", title: "Verification stamp is stale", loc: "projects/example-b.md", evidence: "e", why: "w", action: "a" }], []);

const render = (b = board, seed: string | null = null) => renderToStaticMarkup(
  createElement(LensProvider, null, createElement(OpsScreen, { board: b, secret: "localdev", initialOpenId: seed, decisions: createElement(OpsDecisions, { items, secret: "localdev" }) }))
);

describe("the Ops screen's server render", () => {
  const html = render(board, "groundskeeper");
  it("prints the strip with every figure's window, and Needs you red when non-zero", () => {
    expect(html).toContain('class="opsCell opsCellCrit"');
    expect(html).toContain("open on the register below");
    expect(html).toContain("every unit on schedule");
    expect(html).toContain("groundskeeper · utc");
  });
  it("lists every unit with its state in words and a chevron, and marks the seeded row", () => {
    expect(html.match(/class="opsRow/g)).toHaveLength(2);
    expect(html).toContain("Needs you");
    expect(html).toContain("Succeeded");
    expect(html).toMatch(/id="groundskeeper"[^>]*class="opsRow opsRowOn"[^>]*aria-current="true"/);
    expect(html).toMatch(/id="console-secret"[^>]*class="opsRow opsRowCrit"/);
    expect(html.match(/class="opsGo"/g)).toHaveLength(2);
  });
  it("offers explicit browser enrollment independently of reporter data", () => {
    expect(html).toContain("Register this browser");
    expect(html).toContain("Devices");
    expect(html).toContain("Loading device inventory");
    expect(html).toContain("Claude alone does not enroll");
    expect(html).toContain("Brain groundskeeper");
  });
  it("renders durable commands separately from reporters and names provider prerequisites",()=>{
    expect(html).toContain("Run diagnostics");expect(html).toContain("durable receipts · bounded diagnostics");expect(html).toContain("Checks, migrations and deploy require explicit provider configuration");
  });
  it("opens nothing on the server: the lens is closed until a click, and no inline style is written", () => {
    // The <dialog> is in the markup because showModal() needs an element to open, and the UA
    // sheet hides a closed one (`dialog:not([open]) { display: none }`) and keeps it out of the
    // accessibility tree. What must not ship from the server is an OPEN drawer, and a body
    // inside it — so assert the invariant rather than the absence of the class.
    expect(html).toContain('<dialog class="lens"');
    expect(html).not.toMatch(/<dialog[^>]*\sopen[\s>]/);
    expect(html).not.toContain('class="lensBody"');
    expect(html).not.toContain(' style="');
  });
  it("prints the receipts under their day rules, newest first, with the outcome in words", () => {
    expect(html).toMatch(/2026-09-05.*07:15.*2026-09-04.*09:31/s);
    expect(html).toContain("Console secret: Scheduled → Needs you");
    expect(html).toContain("· 8be1c5c0");
  });
  it("renders Decisions with its count and the item's severity, and the honesty copy", () => {
    expect(html).toContain('class="opsDecisionsN">1<');
    expect(html).toContain('class="opsSev opsSev-warn">warn<');
    expect(html).toContain("1 waiting · 0 proposals · every fix commits");
  });
});

describe("degraded and quiet renders", () => {
  it("a degraded board prints dashes and the degrade line, never a zero", () => {
    const html = render({ ...buildBoard([], new Map(), new Map(), new Map(), [], T0), mode: "unreachable" });
    expect(html).toContain('class="opsStrip opsStripOff"');
    expect(html.match(/class="opsCellFig">—</g)).toHaveLength(4);
    expect(html).toContain("unreachable this render · nothing shown · stamped 08:40:00 utc");
    expect(html).toContain("no receipts yet · the first run writes the first row");
  });
  it("a board that has not reported says so rather than claiming a schedule", () => {
    const html = render(buildBoard(units, new Map(), new Map(), new Map(), [], T0));
    expect(html).toContain("no run reported yet");
    expect(html).toContain("known after the first run reports");
  });
});
