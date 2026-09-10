import { beforeEach, describe, expect, it } from "vitest";
import { PROCESS_CEILING, __resetCeiling, spendOne, spentThisInstance } from "@/app/s/[secret]/console/ask/ceiling";

/**
 * The per-instance ask ceiling. It exists so a stuck tab cannot bill the key in a loop, and the
 * run handler charges a slot BEFORE it calls the reader — so a refused ask costs one too, and the
 * screen's "N of 60" must never appear to refund it.
 *
 * The counter is pinned to globalThis rather than a module `let`, because Next bundles the route
 * handler and the page separately and a module-scoped counter is instantiated twice in one
 * process: the handler would count and the page would forever read zero. That is exactly why
 * __resetCeiling has to exist, and why it now has a test rather than being an exported seam
 * nothing uses.
 */
describe("the per-instance ask ceiling", () => {
  beforeEach(() => __resetCeiling());

  it("starts at zero and counts one per ask", () => {
    expect(spentThisInstance()).toBe(0);
    expect(spendOne()).toBe(1);
    expect(spendOne()).toBe(2);
    expect(spentThisInstance()).toBe(2);
  });

  it("never goes backwards, and the reset is the only thing that clears it", () => {
    for (let i = 0; i < 5; i++) spendOne();
    const seen = spentThisInstance();
    expect(seen).toBe(5);
    // Reading does not spend.
    expect(spentThisInstance()).toBe(seen);
    __resetCeiling();
    expect(spentThisInstance()).toBe(0);
  });

  it("is the same counter whichever module reads it — the globalThis pin", async () => {
    spendOne();
    // A second import must observe the same count; a module-level `let` would give a fresh zero.
    const again = await import("@/app/s/[secret]/console/ask/ceiling");
    expect(again.spentThisInstance()).toBe(1);
  });

  it("states a ceiling the run handler can refuse against", () => {
    expect(PROCESS_CEILING).toBeGreaterThan(0);
    for (let i = 0; i < PROCESS_CEILING; i++) spendOne();
    // The handler's guard is `spentThisInstance() >= PROCESS_CEILING`, so this is the refusing edge.
    expect(spentThisInstance()).toBe(PROCESS_CEILING);
    expect(spentThisInstance() >= PROCESS_CEILING).toBe(true);
  });
});
