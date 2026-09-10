// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LensProvider } from "../app/s/[secret]/console/lens";
import { WorkingState } from "../app/s/[secret]/console/overview/working-state";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
let root: Root;
let host: HTMLDivElement;
let requests: Array<{ url: URL; init?: RequestInit }>;
const item = { id: 7, version: 1, kind: "handoff", project: "harbor", body: "Next: review the release", status: "open", touchedAt: "2026-09-10T00:00:00Z", bodyRedacted: false, projectRedacted: false };
const preview = (project = "harbor") => ({ project, pagePath: `projects/${project}.md`, sha: "deadbeef", budgetBytes: 24000, coverage: `Preview for ${project}`, pieces: [{ kind: "page", label: `projects/${project}.md`, why: "project page", bytes: 100, included: true }], rankExcluded: [], rankExcludedTotal: 0, warnings: [], bubble: "read", graph: "off" });
let previewRequest: (init: RequestInit) => Promise<Response>;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState(null, "", "/s/synthetic/console/overview");
  requests = [];
  previewRequest = async init => Response.json(preview(JSON.parse(String(init.body)).project));
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input, window.location.href);
    requests.push({ url, init });
    if (url.pathname.endsWith("/working-state/projects")) return Response.json({ projects: ["harbor", "kiln"], truncated: false });
    if (url.pathname.endsWith("/heat/handoff")) return previewRequest(init!);
    if (init?.method === "POST") {
      const command = JSON.parse(String(init.body));
      return Response.json({ outcome: "saved", item: { ...item, ...command, id: 7, version: 2, status: command.action === "drop" ? "aged" : "open" } });
    }
    return Response.json({ items: [item], total: 1, swept: 0, next: null });
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
async function mount() { await act(async () => { root.render(createElement(LensProvider, null, createElement(WorkingState, { now: Date.UTC(2026, 8, 10) }))); await flush(); }); }
function button(label: string) {
  const found = [...host.querySelectorAll("button")].find(el => el.textContent === label);
  expect(found, `button: ${label}`).toBeDefined(); return found!;
}
async function click(label: string) { await act(async () => { button(label).click(); await flush(); }); }
async function selectProject(value: string) {
  const select = host.querySelector<HTMLSelectElement>("#working-project");
  expect(select, "explicit project selector").not.toBeNull();
  await act(async () => { select!.value = value; select!.dispatchEvent(new Event("change", { bubbles: true })); await flush(); });
}
const posts = () => requests.filter(r => r.init?.method === "POST");

it("starts with None and cannot preview or save just by selecting or clearing a project", async () => {
  await mount();
  const select = host.querySelector<HTMLSelectElement>("#working-project");
  expect(select, "explicit None option instead of a silently selected first project").not.toBeNull();
  expect(select!.value).toBe(""); expect(select!.selectedOptions[0].textContent).toMatch(/None/);
  expect(button("Preview context").disabled).toBe(true);
  await selectProject("harbor"); expect(button("Preview context").disabled).toBe(false);
  await selectProject(""); expect(button("Preview context").disabled).toBe(true);
  expect(host.textContent).toContain(item.body); expect(posts()).toEqual([]);
});

it("clearing to None fences a late preview and retains saved context", async () => {
  let finish!: (response: Response) => void;
  previewRequest = () => new Promise(resolve => { finish = resolve; });
  await mount(); await selectProject("harbor"); await click("Preview context");
  await selectProject("");
  await act(async () => { finish(Response.json(preview())); await flush(); });
  expect(host.textContent).not.toContain("Preview for harbor");
  expect(host.textContent).toContain(item.body);
  expect(posts()).toHaveLength(1);
  expect(posts()[0].init!.signal!.aborted).toBe(true);
});

it("keeps saved notes visible when None leaves the existing All projects filter unchanged", async () => {
  await mount(); await selectProject("harbor");
  const filter = host.querySelector<HTMLSelectElement>('section[aria-labelledby="working-saved"] select')!;
  await act(async () => { filter.value = "all"; filter.dispatchEvent(new Event("change", { bubbles: true })); await flush(); });
  expect(host.textContent).toContain(item.body);
  await selectProject("");
  expect(host.textContent).toContain(item.body);
  expect(host.textContent).not.toContain("Working notes unavailable");
  expect(posts()).toEqual([]);
});

it("opens a fresh preview for the selected project and closes it without saving", async () => {
  await mount(); await selectProject("harbor"); await click("Preview context");
  expect(host.textContent).toContain("Preview for harbor");
  await click("Close preview");
  await selectProject("kiln"); await click("Preview context");
  expect(host.textContent).toContain("Preview for kiln");
  expect(host.textContent).not.toContain("Preview for harbor");
  await click("Close preview"); await click("Preview context");
  expect(posts().map(r => JSON.parse(String(r.init!.body)))).toEqual([{ project: "harbor" }, { project: "kiln" }, { project: "kiln" }]);
});

it("an explicit Ask shortcut selects only its project and never previews on arrival", async () => {
  window.history.replaceState(null, "", "/s/synthetic/console/overview#working-context?project=kiln");
  await mount();
  const select = host.querySelector<HTMLSelectElement>("#working-project");
  expect(select).not.toBeNull(); expect(select!.value).toBe("kiln");
  expect(posts()).toEqual([]);
  expect(window.location.hash).toBe("#working-context");
});

it("keeps adding general notes available when no project is selected", async () => {
  await mount(); await click("Add general note");
  const project = host.querySelector<HTMLDialogElement>("dialog")!.querySelector<HTMLInputElement>("input")!;
  expect(project.value).toBe(""); expect(posts()).toEqual([]);
});

it("removes a saved item only after its separate confirmation", async () => {
  await mount();
  await act(async () => { host.querySelector<HTMLButtonElement>(".ovWs")!.click(); await flush(); });
  await click("Drop item…"); expect(posts()).toEqual([]);
  await click("Keep item"); expect(posts()).toEqual([]);
  await click("Drop item…"); await click("Confirm age out");
  expect(posts().map(r => JSON.parse(String(r.init!.body)))).toEqual([{ action: "drop", id: 7, version: 1 }]);
  expect(host.textContent).toContain("Retained as history");
});
