import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { displayCollisions } from "./support/css";

/**
 * One class, one component.
 *
 * The console's screens share a flat, unscoped class namespace — no CSS modules, no hashing — so a
 * name is free only until someone takes it. When two different components claim the same one, the
 * rule written later wins at equal specificity and silently reshapes a control it has nothing to do
 * with, from a sheet the author of that control never reads.
 *
 * It happened: the setup steps introduced `.setStep` 250 lines below the numeric stepper control
 * that had claimed it since settings.css:136. Every stepper on Settings — cache lifetime, handoff
 * budget, co-read floor — became a two-column grid holding three children, the plus pushed to a row
 * of its own and a 44px button in a 20px track shoving the value past the box edge, so "7 d" and
 * "24 KB" clipped mid-character. Measured: 107x99 and the value outside its box; after the rename,
 * 165x45 with all three children on one centre line.
 *
 * One declaration per class, full stop. It started narrower — two DIFFERENT `display` values, the
 * signal that a second component had claimed a name and brought its own layout model with it, which
 * is what made the takeover violent: `inline-flex` became `grid`, and three children in a two-track
 * grid is how the plus ended up on its own row.
 *
 * That narrower form deliberately allowed the same value twice, to avoid blocking unrelated work on
 * one known case: console.module.css declared `.chartAxis { display: flex }` at both :83 and :314,
 * where the second quietly won a different margin-top and a `font` shorthand that resets
 * line-height. Same family of bug, and the same-value exemption was the only thing hiding it. That
 * rule is now one rule, so the exemption is gone with it — a class declaring `display` twice is a
 * collision whether or not the two values happen to agree, because what the second rule really
 * takes over is everything ELSE it declares.
 *
 * Scoped to top-level rules on purpose. A media query redeclaring `display` for a class it already
 * owns is a responsive override, which is the point of media queries.
 */
const SHEETS = (() => {
  const root = "app/s/[secret]/console";
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${dir}/${e.name}`);
      else if (e.name.endsWith(".css")) out.push(`${dir}/${e.name}`);
    }
  };
  walk(root);
  return out.sort();
})();

describe("one class, one component", () => {
  // The walker and the claim rule live in tests/support/css.ts, with the comment stripper they
  // depend on. They read a stylesheet through a scanner rather than through
  // `/\/\*[\s\S]*?\*\//g`, because that regex opens a comment on the `/*` inside `content: "/*"`
  // or `url(a/*b.png)` and then deletes every rule up to the next comment close — leaving this
  // guard passing on a sheet it had stopped reading. Proved both ways in css-comment-strip.test.ts.
  it.each(SHEETS)("%s never declares one class twice", (sheet) => {
    const collisions = displayCollisions(readFileSync(sheet, "utf8"));
    expect(
      collisions,
      collisions.length
        ? `two components claim one class name:\n${collisions.map(([k, v]) => `  .${k} declares display ${v.length} times (${v.join(", ")}) — one name, one rule`).join("\n")}`
        : "",
    ).toEqual([]);
  });
});
