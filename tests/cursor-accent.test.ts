// @vitest-environment happy-dom
import { existsSync, readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CursorAccent } from "../app/s/[secret]/console/cursor-accent";
import { saveCursorPreference } from "../app/s/[secret]/console/cursor-preference";

let host: HTMLDivElement, root: ReturnType<typeof createRoot>, style: HTMLStyleElement;
let frames: Map<number, FrameRequestCallback>;
let queries: Map<string, MediaQueryList>;
const desktop = "(min-width: 1100px) and (hover: hover) and (pointer: fine)";

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  frames = new Map(); queries = new Map(); let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.set(++nextFrame, cb); return nextFrame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.spyOn(window, "matchMedia").mockImplementation(media => {
    const query = Object.assign(new EventTarget(), { media, matches: media === desktop }) as MediaQueryList;
    queries.set(media, query); return query;
  });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal("innerWidth", 1440); vi.stubGlobal("innerHeight", 900);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  window.getSelection()?.removeAllRanges();
  host = document.createElement("div"); host.className = "conRoot"; document.body.append(host); root = createRoot(host);
  style = document.createElement("style");
  const cursorCss = "app/s/[secret]/console/cursor-accent.css";
  style.textContent = readFileSync("app/s/[secret]/console/console.css", "utf8") + (existsSync(cursorCss) ? readFileSync(cursorCss, "utf8") : "");
  document.head.append(style);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); style.remove(); window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

const accent = () => host.querySelector<HTMLSpanElement>(".cxCursor")!;
const mount = async (enabled = true) => {
  saveCursorPreference(enabled);
  await act(async () => root.render(createElement(CursorAccent)));
};
const move = (target: Element = host, props: PointerEventInit = {}) => target.dispatchEvent(new PointerEvent("pointermove", {
  bubbles: true, pointerType: "mouse", clientX: 400, clientY: 300, ...props,
}));
const flush = () => {
  const pending = [...frames]; frames.clear();
  for (const [, cb] of pending) cb(100);
};
const media = (name: string, matches: boolean) => {
  const query = queries.get(name)!;
  Object.defineProperty(query, "matches", { value: matches, configurable: true });
  query.dispatchEvent(new Event("change"));
};

it("centers a hollow outline on the native pointer without an offset or solid fill", async () => {
  await mount(); move(); flush();
  expect(accent().hidden).toBe(false);
  expect(accent().style.transform).toBe("translate3d(400px, 300px, 0)");
  const computed = getComputedStyle(accent());
  expect(computed.width).toBe("32px"); expect(computed.height).toBe("32px");
  expect(computed.marginLeft).toBe("-16px"); expect(computed.marginTop).toBe("-16px");
  expect(computed.pointerEvents).toBe("none");
  expect(computed.backgroundColor).toBe("transparent");
  expect(getComputedStyle(host).cursor).not.toBe("none");
  expect(accent().querySelector("svg")?.getAttribute("fill")).toBe("none");
  expect(accent().getAttribute("aria-hidden")).toBe("true");
});

it("rotates the outline slowly in CSS and pauses it whenever it is hidden", async () => {
  await mount(); move(); flush();
  const outline = accent().querySelector("svg");
  expect(outline).not.toBeNull();
  // happy-dom preserves the computed shorthand without expanding its timing longhands.
  expect(getComputedStyle(outline!).animation).toMatch(/\b12s linear infinite normal\b/);
  expect(getComputedStyle(outline!).animationPlayState).toBe("running");
  host.dispatchEvent(new Event("pointerleave"));
  expect(accent().hidden).toBe(true);
  expect(getComputedStyle(outline!).animationPlayState).toBe("paused");
  expect(getComputedStyle(accent()).display).toBe("none");
});

it("coalesces pointer motion to one frame and leaves no idle tracking loop", async () => {
  await mount(); move(); move(host, { clientX: 650, clientY: 380 });
  expect(frames.size).toBe(1); flush();
  expect(accent().style.transform).toBe("translate3d(650px, 380px, 0)");
  expect(frames.size).toBe(0);
});

it.each([
  ["input", ""], ["textarea", ""], ["select", ""], ["dialog", ""],
  ["div", 'contenteditable="true"'], ["div", 'draggable="true"'],
  ["div", 'style="cursor: text"'], ["div", 'style="cursor: vertical-text"'],
] as const)("hides over %s %s", async (tag, attributes) => {
  await mount();
  const target = document.createElement("div"); target.innerHTML = `<${tag} ${attributes}></${tag}>`; host.append(target);
  await act(async () => {});
  move(); flush(); expect(accent().hidden).toBe(false);
  move(target.firstElementChild!); flush();
  expect(accent().hidden).toBe(true); expect(frames.size).toBe(0);
});

it.each([
  { clientX: -1 }, { clientY: -1 }, { clientX: 1440 }, { clientY: 900 },
  { pointerType: "touch" }, { pointerType: "pen" }, { buttons: 1 },
])("hides and cancels pending movement for %j", async props => {
  await mount(); move(); move(host, props); flush();
  expect(accent().hidden).toBe(true); expect(frames.size).toBe(0);
});

it.each([
  "pointerleave", "pointerdown", "dragstart", "keydown",
])("stops when %s interrupts pointer movement", async event => {
  await mount(); move(); flush(); move();
  host.dispatchEvent(new Event(event)); flush();
  expect(accent().hidden).toBe(true); expect(frames.size).toBe(0);
});

it.each([[desktop, false], ["(prefers-reduced-motion: reduce)", true], ["(forced-colors: active)", true]] as const)(
  "stops on media change %s and resumes only on fresh eligible movement", async (query, value) => {
    await mount(); move(); flush(); move(); media(query, value); flush();
    expect(accent().hidden).toBe(true); move(); expect(frames.size).toBe(0);
    media(query, !value); expect(accent().hidden).toBe(true);
    move(); flush(); expect(accent().hidden).toBe(false);
  },
);

it("keeps native text selection uninterrupted", async () => {
  await mount(); const text = document.createTextNode("Selected text"); host.append(text);
  await act(async () => {});
  const range = document.createRange(); range.selectNodeContents(text);
  window.getSelection()!.addRange(range); move(); flush();
  expect(accent().hidden).toBe(true);
  expect(window.getSelection()!.toString()).toBe("Selected text");
});

it("stops on document hiding and requires fresh movement after return", async () => {
  await mount(); move(); flush(); move();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange")); flush();
  expect(accent().hidden).toBe(true); move(); expect(frames.size).toBe(0);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange")); expect(accent().hidden).toBe(true);
  move(); flush(); expect(accent().hidden).toBe(false);
});

it("honors opt-out immediately and releases all pending movement on unmount", async () => {
  await mount(false); move(); expect(frames.size).toBe(0);
  saveCursorPreference(true); move(); flush(); expect(accent().hidden).toBe(false);
  move(); saveCursorPreference(false); flush(); expect(accent().hidden).toBe(true);
  move(); expect(frames.size).toBe(0);
  saveCursorPreference(true); move(); await act(async () => root.render(null));
  expect(frames.size).toBe(0); move(); expect(frames.size).toBe(0);
});
