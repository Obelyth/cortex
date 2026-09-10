import { describe, expect, it } from "vitest";
import { displayCollisions, stripCssComments, topLevelRules } from "./support/css";

/**
 * The stripper the class guards read their stylesheets through, and the guards themselves run
 * over a sheet built to break them.
 *
 * Worth its own test because the failure it prevents is silent: the naive
 * `/\/\*[\s\S]*?\*\//g` sees a comment opener inside a string or a url() and deletes every real
 * rule up to the next comment close. Nothing errors. The guard downstream keeps passing, on a
 * sheet it has stopped reading — which is the one outcome these guards exist to make impossible.
 *
 * So each case here is asserted both ways. Proving the scanner is right is half of it; the other
 * half is proving the regex was wrong, because a fixture that both of them handle proves nothing
 * about the swap, and a guard nobody has ever seen fail is a guard nobody has tested.
 */
const naive = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, " ");

describe("stripCssComments", () => {
  it("removes ordinary comments, including multi-line ones", () => {
    const css = `/* a note */\n.a { color: red; }\n/* two\n   lines */\n.b { color: blue; }`;
    const out = stripCssComments(css);
    expect(out).not.toMatch(/a note|two/);
    expect(out).toContain(".a { color: red; }");
    expect(out).toContain(".b { color: blue; }");
  });

  it("keeps a comment opener that appears inside a quoted string", () => {
    // .hidden is what a guard would be looking for; the naive strip eats it.
    const css = `.marker::before { content: "/*"; }\n.hidden { display: grid; }\n.after { content: "*/"; }`;
    expect(stripCssComments(css)).toContain(".hidden { display: grid; }");
    expect(naive(css), "the naive regex was supposed to lose this rule").not.toContain(".hidden { display: grid; }");
  });

  it("keeps a comment opener that appears inside an unquoted url()", () => {
    const css = `.logo { background: url(assets/a/*b.png); }\n.hidden { display: flex; }\n.tail { color: red; } /* x */`;
    expect(stripCssComments(css)).toContain(".hidden { display: flex; }");
    expect(naive(css), "the naive regex was supposed to lose this rule").not.toContain(".hidden { display: flex; }");
  });

  it("lets the string rule handle a quoted url(), so a ')' inside the quotes cannot end it early", () => {
    const css = `.logo { background: url("a)b/*c.png"); }\n.hidden { display: grid; }\n/* a note */`;
    expect(stripCssComments(css)).toContain(".hidden { display: grid; }");
    expect(naive(css), "the naive regex was supposed to lose this rule").not.toContain(".hidden { display: grid; }");
  });

  it("does not treat an escaped quote as the end of a string", () => {
    const css = `.q::after { content: "he said \\" /* not a comment */ "; }\n.hidden { display: block; }`;
    expect(stripCssComments(css)).toContain(".hidden { display: block; }");
  });

  it("an unterminated comment still swallows the rest, as CSS itself does", () => {
    expect(stripCssComments(`.a { color: red; } /* never closed`).trim()).toBe(".a { color: red; }");
  });

  it("leaves a sheet with no comments byte-identical", () => {
    const css = `.a { color: red; }\n.b { background: url(x.png); content: "y"; }`;
    expect(stripCssComments(css)).toBe(css);
  });
});

/**
 * The .setStep incident, rebuilt with a poisoned declaration in front of it.
 *
 * The real one: the setup steps claimed `.setStep` 250 lines below the numeric stepper that had
 * owned it since settings.css:136, and every stepper on Settings became a two-column grid holding
 * three children. The guard that now catches it is displayCollisions(). These sheets put a
 * `content: "/*"` — and, in the second, a `url(a/*b.png)` — above the second claim, which is all
 * it takes for the regex to delete the rule the guard is hunting for.
 *
 * It takes one more thing, and it is the part that makes this realistic rather than contrived: a
 * fake opener swallows nothing until some later comment closes it. Real sheets supply that for
 * free — settings.css alone carries dozens of ordinary comments, and the first one after the
 * poison is the trap door. So the note below is doing the same job the sheet's own prose would.
 */
const POISON = {
  string: `.marker::before { content: "/*"; }`,
  url: `.logo { background: url(assets/a/*b.png); }`,
};
const stepperSheet = (poison: string) => `
.setStep { display: inline-flex; gap: 6px; }
${poison}
.setStep { display: grid; grid-template-columns: 20px 1fr; }
/* the stepper's own note — an ordinary comment, and the close the fake opener was waiting for */
.setRow { display: flex; }
`;

describe("the collision guard over a sheet built to hide a collision from it", () => {
  it.each(Object.entries(POISON))("a %s comment opener does not blind it", (_kind, poison) => {
    const sheet = stepperSheet(poison);

    // What the guard does now: it sees both claims and names the class.
    expect(displayCollisions(sheet)).toEqual([["setStep", ["inline-flex", "grid"]]]);

    // What it did before. Same walker, same claim rule, only the strip swapped — so the
    // difference below is the strip and nothing else.
    expect(
      displayCollisions(sheet, naive),
      "the naive strip was supposed to leave this guard with nothing to find",
    ).toEqual([]);
  });

  it("the rule the naive strip loses is the second claim itself, not merely its comment", () => {
    // Spelling out the mechanism the assertions above turn on: the regex opens a comment at the
    // `/*` inside content: "..." and closes it at the end of the next ordinary comment, taking
    // every rule in between with it. The guard is then reading half a sheet and cannot say so.
    const sheet = stepperSheet(POISON.string);
    expect(topLevelRules(sheet).map((r) => r.sel)).toEqual([".setStep", ".marker::before", ".setStep", ".setRow"]);
    expect(topLevelRules(sheet, naive).map((r) => r.sel)).toEqual([".setStep", ".marker::before"]);
  });

  it("a sheet with no poison in it reads the same either way", () => {
    // The swap is not a behaviour change on the sheets this repo actually ships; it only removes
    // a way for those sheets to start lying later.
    const clean = `.a { display: flex; }\n/* a note about .a */\n.a { display: grid; }`;
    expect(displayCollisions(clean)).toEqual(displayCollisions(clean, naive));
    expect(displayCollisions(clean)).toEqual([["a", ["flex", "grid"]]]);
  });
});

/**
 * The other shape of CSS guard: "this selector is gone from that sheet" (settings-classes) and
 * "these are the only ops* classes left in the shell" (ops-classes). Both match a regex against
 * stripped text, so both go quiet in the same way — the selector they would have objected to is
 * inside the region the regex deleted.
 */
describe("the retired-selector guards over the same trick", () => {
  const sheet = `
.keep { display: flex; }
.marker::before { content: "/*"; }
.setRow { display: block; padding: 4px; }
.opsGhost { color: red; }
.tail { content: "*/"; }
`;

  it("sees a retired selector the naive strip had hidden", () => {
    expect(stripCssComments(sheet), "the guard must still be able to object").toMatch(/\.setRow(?![A-Za-z0-9_-])/);
    expect(naive(sheet), "the naive strip was supposed to hide it").not.toMatch(/\.setRow(?![A-Za-z0-9_-])/);
  });

  it("sees an ops* class the naive strip had hidden", () => {
    const left = (text: string) => [...new Set([...text.matchAll(/\.(ops[A-Za-z0-9-]*)/g)].map((m) => m[1]))].sort();
    expect(left(stripCssComments(sheet))).toEqual(["opsGhost"]);
    expect(left(naive(sheet)), "the naive strip was supposed to hide it").toEqual([]);
  });

  // Both of these passed the suite while the defect was live, which is the point of adding them:
  // the scanner's failures are silent by construction.
  it.each(["", " ", "  ", "   ", "\n  "])("keeps a url() opener after %j of whitespace", (gap) => {
    // The detector used to peek through a fixed 6-character slice, wide enough for one space only.
    const css = `.logo { background: url(${gap}a/*b.png); }\n.hidden { display: flex; }`;
    expect(stripCssComments(css)).toContain(".hidden { display: flex; }");
  });

  it("does not treat url(\"a/*b.png\") as an unquoted token", () => {
    // The quoted form is the string rule's business; a ")" inside the quotes must not end it early.
    const css = `.logo { background: url("a)b.png"); }\n.hidden { display: grid; }`;
    expect(stripCssComments(css)).toContain(".hidden { display: grid; }");
  });

  it("an unpaired quote stops at its own line instead of running on", () => {
    const css = `.a::after { content: "x; }\n/* strip me */\n.hidden { display: block; }`;
    const out = stripCssComments(css);
    expect(out).toContain(".hidden { display: block; }");
    expect(out).not.toContain("strip me");
  });
});
