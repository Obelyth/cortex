// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { LensProvider } from "../app/s/[secret]/console/lens";
import { AskProvider, AskReadout } from "../app/s/[secret]/console/ask/ask-explorer";
import type { AskModel } from "../app/s/[secret]/console/ask/ask-model";
const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
const model: AskModel = {
  sha: "deadbeef", notes: ["harbor", "kiln"].map(name => ({ path: `projects/${name}.md`, dir: "projects", title: name, desc: "Synthetic project", headings: [], blocks: 1, tokens: 10, retracted: 0, age: 1, decays: false })),
  heat: [], skipped: [], retractedByPath: {}, connections: null, units: [], tools: [], reader: null, readerError: null,
  spent: 0, ceiling: 60, narrowing: { k: 15, maxLogs: 1, maxPartsPerPage: 2, budgetBytes: 24000 }, corpusTokens: 20,
  seat: { tokens: 5, parts: [] }, scoring: "off", coldStart: false, pinsAvailable: false,
  glance: { asks: 0, verified: 0, superseded: 0, partial: 0, unverified: 0, notInBrain: 0, errors: 0, cutOff: 0, timedOut: 0, source: "unconfigured", covers: 0 },
  repoUrl: null, initial: { note: null, q: null, find: null, sort: null },
};
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState(null, "", "/s/synthetic/console/ask/");
  nav.push.mockClear(); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("navigation must not request a preview"); }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function mount(note: string | null = null) {
  await act(async () => { root.render(createElement(LensProvider, null, createElement(AskProvider, { model: { ...model, initial: { ...model.initial, note } }, children: createElement(AskReadout) }))); });
}
it.each(["synthetic", "console"])("offers one working-context shortcut with the %s secret intact", async secret => {
  window.history.replaceState(null, "", `/s/${secret}/console/ask/`);
  await mount();
  expect(host.querySelector("select")).toBeNull();
  const button = [...host.querySelectorAll("button")].find(el => el.textContent === "Manage working context");
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(nav.push).toHaveBeenCalledWith(`/s/${secret}/console/overview#working-context`);
  expect(fetch).not.toHaveBeenCalled();
});
it("a project note opens the same home with that exact project, without starting a preview", async () => {
  await mount("projects/kiln.md");
  const replace = vi.spyOn(window.history, "replaceState");
  const button = [...host.querySelectorAll("button")].find(el => el.textContent === "Open working context");
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(nav.push).toHaveBeenCalledWith("/s/synthetic/console/overview#working-context?project=kiln");
  expect(replace).not.toHaveBeenCalled(); // A competing native-history update cancels Next navigation.
  expect(fetch).not.toHaveBeenCalled();
});
