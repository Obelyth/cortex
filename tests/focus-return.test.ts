import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { chooseReturn, type ReturnTargets } from "@/app/s/[secret]/console/focus-return";
import { nextLensState, type LensContent } from "@/app/s/[secret]/console/lens";
import { stripTsComments } from "./support/css";

/**
 * The overlay's return-focus rule. This repo's vitest is `environment: "node"` with no jsdom, so
 * the rule is a pure function over the nodes and is proved here; the wiring that applies it is
 * verified in a headless browser against the render harness, the way every console screen is.
 *
 * Stand-ins rather than a DOM: `chooseReturn` only ever asks whether a node is connected and
 * whether the overlay contains it, so a handful of objects answer honestly for both.
 */
const node = (id: string, opts: { connected?: boolean } = {}) =>
  ({ id, isConnected: opts.connected ?? true, contains: () => false }) as unknown as Element;

const overlayWith = (...kids: Element[]) =>
  ({ isConnected: true, contains: (n: Element) => kids.includes(n) }) as unknown as Element;

const floor = node("body");
const base = (over: Partial<ReturnTargets>): ReturnTargets => ({
  active: floor, opener: null, openerId: null, overlay: null, floor, ...over,
});

describe("where focus goes when an overlay closes", () => {
  it("stands down when a body moved focus on purpose", () => {
    // Ask's askAbout closes the lens and focuses the question input. Restoring to the mark that
    // opened the drawer would undo the one thing that flow exists to do.
    const input = node("ask-q");
    const c = chooseReturn(base({ active: input, opener: node("mark-402"), overlay: overlayWith() }));
    expect(c.to).toBe("stand-down");
  });

  it("returns to the opener in the ordinary case", () => {
    const opener = node("mark-402");
    const c = chooseReturn(base({ active: floor, opener, overlay: overlayWith() }));
    expect(c.to).toBe("opener");
  });

  it("counts focus inside the closing overlay as the ordinary case, not a deliberate move", () => {
    // The close button lives in the overlay; pressing it must still return focus to the opener.
    const closeBtn = node("lens-close");
    const opener = node("row-7");
    const c = chooseReturn(base({ active: closeBtn, opener, overlay: overlayWith(closeBtn) }));
    expect(c.to).toBe("opener");
  });

  it("re-queries the id when a re-read replaced the opener's node", () => {
    // ops-client refreshes the board under an open drawer: same row, new element.
    const gone = node("groundskeeper", { connected: false });
    const c = chooseReturn(base({ active: floor, opener: gone, openerId: "groundskeeper", overlay: overlayWith() }));
    expect(c).toMatchObject({ to: "opener-id", id: "groundskeeper" });
  });

  it("falls to the main landmark, never to the body", () => {
    const gone = node("mark-402", { connected: false });
    const c = chooseReturn(base({ active: floor, opener: gone, openerId: null, overlay: overlayWith() }));
    expect(c.to).toBe("main");
  });

  it("treats no focus at all the same as focus on the floor", () => {
    const opener = node("row-1");
    expect(chooseReturn(base({ active: null, opener, overlay: overlayWith() })).to).toBe("opener");
  });

  it("prefers the live opener over its id — the id is the fallback, not the rule", () => {
    const opener = node("row-1");
    const c = chooseReturn(base({ active: floor, opener, openerId: "row-1", overlay: overlayWith() }));
    expect(c.to).toBe("opener");
  });
});

describe("the lens opener lifecycle", () => {
  const content = (title: string): LensContent => ({ kind: "handoff", title, body: null });

  it("keeps the page control that opened the drawer when async content republishes", () => {
    const button = node("ask-handoff-project");
    const dialog = node("lens");
    const loading = nextLensState(null, content("assembling"), button);
    const ready = nextLensState(loading, content("preview ready"), dialog);

    expect(ready.opener).toBe(button);
  });
});

describe("the console has one overlay, and it is honest about being modal", () => {
  /** Source with comments stripped: these files explain in prose why aria-modal was removed, and
   *  a guard that reads prose would fail on the very comment recording the fix.
   *
   *  Through the scanner in tests/support/css.ts rather than a regex. The regex this replaced saw
   *  a comment opener in any `/*` it found, including the ones inside string literals and template
   *  literals, and each one deleted every line up to the next comment close — so the guards below
   *  would have gone on passing over source they had stopped reading. Its JSX-comment pass was
   *  also dead code: the pass before it had already eaten the comment, leaving nothing for it to
   *  match. The scanner keeps that outcome, braces and all. */
  const read = (p: string) => stripTsComments(readFileSync(p, "utf8"));
  const LENS = "app/s/[secret]/console/lens.tsx";
  const TRAY = "app/s/[secret]/console/notices-tray.tsx";
  const OVERLAY = "app/s/[secret]/console/overlay.tsx";
  const LAYOUT = "app/s/[secret]/console/layout.tsx";

  it("the lens is the native dialog, not a hand-rolled aside", () => {
    const src = read(LENS);
    expect(src).toContain("<Overlay");
    // The old shape: an aside claiming modality with no focus management behind it.
    expect(src).not.toMatch(/aria-modal=/);
    expect(src).not.toMatch(/className="lensDim"/);
  });

  it("the tray no longer claims a modality it does not have", () => {
    const src = read(TRAY);
    // Its bell sits in the masthead behind it. A real modal would make that bell inert and stop
    // it toggling the tray closed, so the tray is a labelled group the bell owns instead.
    expect(src).not.toMatch(/aria-modal=/);
    expect(src).toContain('aria-expanded={open}');
    // kinetic.tsx excludes client components by construction, so a reveal attribute here is dead.
    expect(src).not.toMatch(/data-cx=/);
  });

  it("no screen builds a second drawer", () => {
    // Eleven call sites open the one lens through useLens(); a bespoke dialog anywhere else is
    // the thing the primitive exists to prevent.
    const screens = readdirSync("app/s/[secret]/console", { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => {
        const dir = `app/s/[secret]/console/${d.name}`;
        return readdirSync(dir).filter((f) => f.endsWith(".tsx")).map((f) => `${dir}/${f}`);
      });
    const offenders = screens.filter((f) => /aria-modal=|<dialog[\s>]/.test(read(f)));
    expect(offenders, `a second drawer appeared in:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("the main landmark can actually take the focus step 3 sends it", () => {
    // Measured in Chromium against the real page, both ways: with tabindex="-1" a programmatic
    // main.focus() lands on MAIN; without it the call is a silent no-op and focus stays on BODY —
    // which is focus nowhere, the exact outcome step 3 exists to avoid. So the rule's last step is
    // only as good as this attribute, and the attribute is easy to lose in a layout tidy-up.
    // Matched on the tag itself, not on any mention of the word: comments and prose about the
    // landmark must neither satisfy this guard nor break it.
    const main = read(LAYOUT).match(/<main\b[^>]*>/);
    expect(main, "no <main> element in the console layout").not.toBeNull();
    expect(main![0]).toContain('className="conBody"');
    expect(main![0]).toMatch(/tabIndex=\{-1\}/);
  });

  it("the overlay closes from the effect body, never from its cleanup", () => {
    // A cleanup runs on unmount too. Closing there turns React tearing the tree down into a close
    // event, and the restore then chases focus into nodes that are being removed. Removing an open
    // dialog from the document already closes it silently — the platform's removing steps destroy
    // the close watcher without firing close — so the unmount case needs no code, only that no
    // close() call sits in a returned cleanup function.
    const src = read(OVERLAY);
    // Brace-matched rather than regex-matched, so a cleanup that later grows a nested block is
    // still read whole instead of being truncated at the first "}" and silently passing.
    const cleanups: string[] = [];
    for (const m of src.matchAll(/return \(\) => \{/g)) {
      let depth = 0;
      let i = m.index! + m[0].length - 1;
      do { if (src[i] === "{") depth++; else if (src[i] === "}") depth--; i++; } while (depth > 0 && i < src.length);
      cleanups.push(src.slice(m.index!, i));
    }
    expect(cleanups.length, "the scroll-lock cleanup went missing").toBeGreaterThan(0);
    for (const c of cleanups) expect(c, `a cleanup closes the dialog:\n${c}`).not.toMatch(/\.close\(\)/);
  });

  it("the opener reaches the overlay as state, not as a ref read during render", () => {
    // A ref written in the click handler and read in the render body is not reactive, and it
    // outlives the close: a later render hands the overlay an opener belonging to a drawer that is
    // no longer up. Content and opener go into one setState so they cannot disagree.
    const src = read(LENS);
    expect(src).not.toMatch(/useRef/);
    expect(src).toMatch(/opener=\{state\?\.opener \?\? null\}/);
  });
});
