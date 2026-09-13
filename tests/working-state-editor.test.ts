import { beforeEach, expect, it, vi } from "vitest";
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { WorkingStateEditor } from "../app/s/[secret]/console/working-state-editor";
import type { WorkingItem } from "../lib/working-state-contract";

// A bounded hook runner exercises the actual editor handlers without a DOM dependency.
// Root's browser gate covers React scheduling, native inputs and drawer focus.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
vi.mock("react", async (load) => ({
  ...await load<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = value; }];
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index];
  },
}));
vi.mock("../app/s/[secret]/console/lens", () => ({ useLens: () => ({ close: vi.fn() }) }));

type Element = ReactElement<Record<string, any>>;
function elements(node: ReactNode): Element[] {
  return Children.toArray(node).flatMap(child => isValidElement<Record<string, any>>(child)
    ? [child, ...elements(child.props.children)] : []);
}
function labelText(node: ReactNode): string {
  return Children.toArray(node).map(child => isValidElement<Record<string, any>>(child)
    ? child.props["aria-hidden"] === true || child.props["aria-hidden"] === "true" ? "" : labelText(child.props.children) : String(child)).join("");
}
it("keeps aria-hidden false labels while excluding decorative true labels", () => {
  for (const hidden of [false, "false", undefined]) expect(labelText(createElement("span", { "aria-hidden": hidden as false }, "Save"))).toBe("Save");
  for (const hidden of [true, "true"]) expect(labelText(createElement("span", { "aria-hidden": hidden as true }, "Decoration"))).toBe("");
});
const ordinary: WorkingItem = { id: 7, version: 2, kind: "handoff", project: "harbor", body: "Original notes", bodyRedacted: false, projectRedacted: false, status: "open", touchedAt: "2026-09-08T12:00:00Z" };
const masked: WorkingItem = { ...ordinary, version: 3, project: "token=<redacted>", body: "password=<redacted>", bodyRedacted: true, projectRedacted: true };
beforeEach(() => {
  hooks.slots = []; hooks.cursor = 0;
  vi.stubGlobal("window", { location: { pathname: "/s/synthetic/console/overview" } });
});

function editor(item: WorkingItem) {
  const render = () => { hooks.cursor = 0; return elements(WorkingStateEditor({ item, onSaved: vi.fn() })); };
  const field = (name: "body" | "project") => render().find(el => el.type === (name === "body" ? "textarea" : "input"))!;
  const click = (label: string) => render().find(el => el.type === "button" && labelText(el.props.children) === label)!.props.onClick();
  const submit = () => render().find(el => el.type === "form")!.props.onSubmit({ preventDefault() {} });
  const idle = () => vi.waitFor(() => expect(field("body").props.disabled).toBe(false));
  const status = () => String(render().find(el => el.props.role === "status")!.props.children);
  const saveButton = () => render().find(el => el.type === "button" && el.props.type === "submit")!;
  const verified = () => vi.waitFor(() => expect(status()).toContain("Verified item"));
  return { field, click, submit, idle, verified, status, saveButton };
}

it("holds an authored draft back, and says so, when a conflict refresh brings a redacted item — until replacement is chosen", async () => {
  // Before: the authored text sat read-only in the field, Save stayed enabled, the command
  // omitted it, and the status read "Saved". The draft was discarded without a word.
  const ui = editor(ordinary);
  ui.field("body").props.onChange({ target: { value: "My authored next action" } });
  ui.field("project").props.onChange({ target: { value: "my-project-draft" } });
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ code: "conflict", current: masked }, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ item: masked }))
    .mockResolvedValueOnce(Response.json({ outcome: "saved", item: { ...ordinary, version: 4 } }));
  vi.stubGlobal("fetch", fetch);
  ui.submit(); await ui.idle();
  ui.click("Refresh item"); await ui.idle();
  ui.click("Use refreshed version; keep my draft");
  expect(ui.field("body").props.value).toBe("My authored next action");
  expect(ui.field("body").props.readOnly).toBe(true);
  expect(ui.saveButton().props.disabled).toBe(true);
  expect(ui.status()).toMatch(/notes and project are held back.*Replace hidden notes and Replace project/);
  // A submit while held sends nothing.
  ui.submit(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(fetch).toHaveBeenCalledTimes(2);
  ui.click("Replace hidden notes");
  expect(ui.saveButton().props.disabled).toBe(true);
  expect(ui.status()).toMatch(/^Your project is held back/);
  ui.click("Replace project");
  expect(ui.saveButton().props.disabled).toBe(false);
  expect(ui.status()).toBe("");
  ui.submit(); await ui.verified();
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(JSON.parse(fetch.mock.calls[2][1].body)).toMatchObject({ id: 7, version: 3, body: "My authored next action", project: "my-project-draft" });
});

it("does not hold an untouched draft: a kind-only edit over a redacted item saves without the body", async () => {
  const ui = editor(ordinary);
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ item: masked }))
    .mockResolvedValueOnce(Response.json({ outcome: "saved", item: { ...masked, version: 4 } }));
  vi.stubGlobal("fetch", fetch);
  ui.click("Refresh item"); await ui.idle();
  ui.click("Use refreshed version; keep my draft");
  expect(ui.field("body").props.readOnly).toBe(true);
  expect(ui.saveButton().props.disabled).toBe(false);
  expect(ui.status()).toBe("");
  ui.submit(); await ui.verified();
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ action: "edit", id: 7, version: 3, kind: "handoff" });
});

it.each([false, true])("keeps authored body and project through masked conflict refresh (initially masked: %s)", async initiallyMasked => {
  const ui = editor(initiallyMasked ? { ...masked, version: 2 } : ordinary);
  if (initiallyMasked) { ui.click("Replace hidden notes"); ui.click("Replace project"); }
  ui.field("body").props.onChange({ target: { value: "My authored next action" } });
  ui.field("project").props.onChange({ target: { value: "my-project-draft" } });
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ code: "conflict", current: masked }, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ item: masked }))
    .mockResolvedValueOnce(Response.json({ outcome: "saved", item: { ...ordinary, version: 4 } }));
  vi.stubGlobal("fetch", fetch);
  ui.submit(); await ui.idle();
  ui.click("Refresh item"); await ui.idle();
  ui.click("Use refreshed version; keep my draft");
  expect(ui.field("body").props.value).toBe("My authored next action");
  expect(ui.field("project").props.value).toBe("my-project-draft");
  expect(ui.field("body").props.readOnly).toBe(true);
  expect(ui.field("project").props.readOnly).toBe(true);
  ui.click("Replace hidden notes"); ui.click("Replace project");
  expect(ui.field("body").props.value).toBe("My authored next action");
  expect(ui.field("project").props.value).toBe("my-project-draft");
  ui.submit();
  await ui.verified();
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(JSON.parse(fetch.mock.calls[2][1].body)).toMatchObject({ id: 7, version: 3, body: "My authored next action", project: "my-project-draft" });
});

it("never promotes original masked placeholders after an ordinary refresh", async () => {
  const ui = editor({ ...masked, version: 2 });
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ item: { ...ordinary, version: 3 } }))
    .mockResolvedValueOnce(Response.json({ outcome: "saved", item: { ...ordinary, version: 4 } }));
  vi.stubGlobal("fetch", fetch);
  ui.click("Refresh item"); await ui.idle();
  ui.click("Use refreshed version; keep my draft");
  expect(ui.field("body").props.readOnly).toBe(true);
  expect(ui.field("project").props.readOnly).toBe(true);
  ui.submit(); await ui.verified();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ action: "edit", id: 7, version: 3, kind: "handoff" });
});

it("clears only masked placeholders when explicitly starting replacement after an ordinary refresh", async () => {
  const ui = editor(masked);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ item: { ...ordinary, version: 4 } })));
  ui.click("Refresh item"); await ui.idle();
  ui.click("Use refreshed version; keep my draft");
  ui.click("Replace hidden notes"); ui.click("Replace project");
  expect(ui.field("body").props.value).toBe("");
  expect(ui.field("project").props.value).toBe("");
  expect(ui.field("body").props.readOnly).toBe(false);
  expect(ui.field("project").props.readOnly).toBe(false);
});
