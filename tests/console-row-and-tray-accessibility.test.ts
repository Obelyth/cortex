// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBoard } from "@/lib/ops-board";
import type { Unit } from "@/lib/ops-state";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
}));
vi.mock("@/app/s/[secret]/console/overlay", () => ({
  Overlay: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? createElement("aside", { className: "testLens" }, children) : null,
}));
vi.mock("@/app/s/[secret]/console/ops/command-panel", () => ({ CommandPanel: () => null }));

const { LensProvider } = await import("@/app/s/[secret]/console/lens");
const { NoticesBell } = await import("@/app/s/[secret]/console/notices-tray");
const { OpsClient } = await import("@/app/s/[secret]/console/ops/ops-client");

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("the notices disclosure", () => {
  it("uses a native backdrop control, ignores inside clicks, and restores focus on close", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ mode: "live", notices: [], unread: 0 })));
    await act(async () => root.render(createElement(NoticesBell, { secret: "synthetic" })));

    const bell = host.querySelector<HTMLButtonElement>('.ntBell')!;
    bell.focus();
    await act(async () => bell.click());

    const tray = host.querySelector<HTMLElement>(".ntTray")!;
    expect(document.activeElement).toBe(tray);
    await act(async () => tray.click());
    expect(host.querySelector(".ntTray")).not.toBeNull();

    const backdrop = host.querySelector<HTMLButtonElement>('button[aria-label="Close notices"]');
    expect(backdrop).toBeInstanceOf(HTMLButtonElement);
    await act(async () => backdrop!.click());

    expect(host.querySelector(".ntTray")).toBeNull();
    expect(document.activeElement).toBe(bell);

    await act(async () => bell.click());
    expect(host.querySelector(".ntTray")).not.toBeNull();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(host.querySelector(".ntTray")).toBeNull();
    expect(document.activeElement).toBe(bell);
  });
});

describe("the Ops register row", () => {
  it("keeps table row semantics while its native named control opens the unit", async () => {
    const unit: Unit = {
      id: "groundskeeper", name: "Brain groundskeeper", kind: "routine", owner: "manager",
      period_s: 86400, grace_s: 1800, max_run_s: 1200, pages: true, tolerance: 1,
      paused_until: null, run_now: { kind: "dispatch", target: "run-groundskeeper" }, notes: null,
    };
    const board = buildBoard([unit], new Map(), new Map(), new Map(), [], new Date("2026-09-10T12:00:00Z"));
    await act(async () => root.render(createElement(
      LensProvider,
      null,
      createElement(OpsClient, { board, secret: "synthetic", decisions: null }),
    )));

    const row = host.querySelector<HTMLElement>('.opsRow[role="row"]')!;
    expect(row).not.toBeNull();
    expect(row.onclick).toBeNull();
    expect(row.querySelectorAll('[role="cell"]')).toHaveLength(6);

    const opener = row.querySelector<HTMLButtonElement>('button[aria-label="Open Brain groundskeeper"]');
    expect(opener).toBeInstanceOf(HTMLButtonElement);
    await act(async () => opener!.click());
    expect(host.querySelector(".lensTitle")?.textContent).toBe("Brain groundskeeper");
  });
});
