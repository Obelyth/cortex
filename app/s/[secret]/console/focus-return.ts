/**
 * Where focus goes when an overlay closes.
 *
 * The decision is here, as a pure function over the DOM nodes involved, because this repo's
 * vitest runs `environment: "node"` with no jsdom — so a test can prove the RULE even though it
 * cannot drive a real dialog. The wiring that applies the rule lives in overlay.tsx and is
 * verified the way every console screen is: rendered and driven in a headless browser.
 *
 * Four steps, in order, each answering a case the console actually produces:
 *
 *  0. Stand down. If focus already sits somewhere that is neither the page floor nor inside the
 *     closing overlay, a body moved it on purpose and we must not fight it. Ask's `askAbout`
 *     does exactly this — it closes the lens and focuses the question input — and any restore
 *     that ignored the case would yank the operator back to the mark they clicked.
 *  1. The opener, if it is still in the document. The ordinary case.
 *  2. The opener's id, re-queried. A board that re-read underneath the drawer replaces the row
 *     node while keeping its id, so the node we captured is detached but the row is still there.
 *  3. The page's main landmark. Never `<body>`: focus on the body is focus nowhere, and a screen
 *     reader announces nothing rather than "main".
 */
export interface ReturnTargets {
  /** Where focus is right now, at the moment the overlay is closing. */
  active: Element | null;
  /** The element that opened the overlay, captured when it opened. */
  opener: Element | null;
  /** The opener's id, if it had one, for re-querying a replaced node. */
  openerId: string | null;
  /** The overlay's own root, so we can tell "inside the overlay" from "somewhere else". */
  overlay: Element | null;
  /** The page floor — `document.body`, and `null`/`undefined` for "no focus". */
  floor: Element | null;
}

export type ReturnChoice =
  | { to: "stand-down"; why: string }
  | { to: "opener"; why: string }
  | { to: "opener-id"; id: string; why: string }
  | { to: "main"; why: string };

const connected = (el: Element | null): boolean => Boolean(el && el.isConnected);

/** True when focus is nowhere in particular: unset, or resting on the page floor. */
function onFloor(active: Element | null, floor: Element | null): boolean {
  return active === null || active === floor;
}

export function chooseReturn(t: ReturnTargets): ReturnChoice {
  const inOverlay = Boolean(t.overlay && t.active && t.overlay.contains(t.active));
  if (!onFloor(t.active, t.floor) && !inOverlay) {
    return { to: "stand-down", why: "a body moved focus deliberately before closing" };
  }
  if (connected(t.opener)) {
    return { to: "opener", why: "the element that opened the overlay is still in the document" };
  }
  if (t.openerId) {
    return { to: "opener-id", id: t.openerId, why: "the opener was replaced by a re-read; its id survives" };
  }
  return { to: "main", why: "the opener is gone and unrecoverable; the main landmark is the floor we admit to" };
}
