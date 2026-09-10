import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripTsComments } from "./support/css";

/**
 * The stripper focus-return.test.ts reads the console's source through, and that guard run over
 * source built to break it.
 *
 * Same silent failure as the stylesheet side, one language over. focus-return matches on the
 * absence of things — no `aria-modal=`, no second `<dialog`, no `.close()` in a cleanup — and an
 * absence is exactly what a strip that deleted the file's middle produces. The naive regex found
 * a comment opener in any `/*` at all, including the ones inside string and template literals,
 * and every guard downstream would have kept passing over source it had stopped reading.
 *
 * Both halves are asserted throughout: what the scanner keeps, and what the regex lost.
 */
const naive = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

describe("stripTsComments", () => {
  it("removes block and line comments, including multi-line ones", () => {
    const src = `/* a note */\nconst a = 1;\n// a line\n/* two\n   lines */\nconst b = 2;`;
    const out = stripTsComments(src);
    expect(out).not.toMatch(/a note|a line|two/);
    expect(out).toContain("const a = 1;");
    expect(out).toContain("const b = 2;");
  });

  it("keeps a comment opener that appears inside a string literal", () => {
    const src = `const open = "/*";\n<aside aria-modal="true" />\n/* an ordinary note */\n`;
    expect(stripTsComments(src), "the guard must still be able to object").toMatch(/aria-modal=/);
    expect(naive(src), "the naive regex was supposed to hide this").not.toMatch(/aria-modal=/);
  });

  it("keeps a comment opener that appears inside a template literal", () => {
    const src = "const t = `a /* b`;\n<aside aria-modal=\"true\" />\n/* an ordinary note */\n";
    expect(stripTsComments(src)).toMatch(/aria-modal=/);
    expect(naive(src), "the naive regex was supposed to hide this").not.toMatch(/aria-modal=/);
  });

  it("follows a template literal through its ${ } holes, and back out again", () => {
    const src = "const t = `x ${ cond ? `/* inner */` : \"/*\" } y`;\n<dialog />\n/* note */\n";
    expect(stripTsComments(src)).toContain("<dialog />");
    expect(naive(src), "the naive regex was supposed to hide this").not.toContain("<dialog />");
  });

  it("leaves a URL alone, because JSX text is not a string literal", () => {
    // The reason line comments are only stripped where "//" opens a line. A bare URL in the
    // middle of a line of markup is content, and eating the rest of that line would take the
    // closing tag with it.
    const src = `<p>see https://example.com/x for the rest</p>`;
    expect(stripTsComments(src)).toBe(src);
  });

  it("does not read a regex literal's escaped slash as a line comment", () => {
    // Verbatim from app/s/[secret]/console/settings/wire-client.tsx:127. The `\\/` that ends the
    // pattern sits immediately before the closing delimiter, so the raw text carries a "//" that
    // is not a comment. A scanner that skipped regex literals would eat the rest of the line.
    const src = `const m = window.location.pathname.match(/^\\/s\\/([^/]+)\\//);\n<dialog />`;
    expect(stripTsComments(src)).toContain("<dialog />");
    expect(stripTsComments(src)).toContain(");");
  });

  it("does not read a comment opener inside a regex literal as a comment", () => {
    const src = `const re = /a\\/*b/;\n<aside aria-modal="true" />\n/* note */\n`;
    expect(stripTsComments(src)).toMatch(/aria-modal=/);
  });

  it("treats a slash after a value as division, not as a regex", () => {
    // `up[i] / maxU` and `bw / 2` are real lines in overview/activity-chart.tsx. Reading either
    // slash as a regex opener would swallow markup up to the next slash on the line.
    const src = `const hu = (up[i] / maxU) * (mid - T);\nconst x = bw / 2;\n<rect rx={1.5} />`;
    expect(stripTsComments(src)).toBe(src);
  });

  it("leaves JSX tags alone: a closing tag and a self-close are not regex delimiters", () => {
    const src = `<div className={cls}><span>{label}</span><br /></div>`;
    expect(stripTsComments(src)).toBe(src);
  });

  it("strips a JSX comment's text and leaves its braces, as the guard has always seen it", () => {
    // An empty pair is balanced, so the cleanup brace-matcher in focus-return reads the same
    // either way. Telling a JSX child apart from a code block would take a parser; this costs
    // nothing and changes nothing.
    const out = stripTsComments(`<div>{/* a note about <dialog> */}</div>`);
    expect(out).not.toMatch(/a note|<dialog/);
    expect(out).toMatch(/<div>\{\s*\}<\/div>/);
  });

  it("an unterminated block comment still swallows the rest", () => {
    expect(stripTsComments(`const a = 1; /* never closed`).trim()).toBe("const a = 1;");
  });

  it("leaves source with no comments byte-identical", () => {
    const src = `const a = "x";\nconst b = \`y \${a} z\`;\nconst c = a.replace(/x/g, "-");\n<br />`;
    expect(stripTsComments(src)).toBe(src);
  });
});

/**
 * The guard itself, run over a file built to hide a second drawer from it.
 *
 * focus-return's "no screen builds a second drawer" test reads every .tsx under the console and
 * fails on any `aria-modal=` or `<dialog`. This is that test's own predicate, over source whose
 * first line opens a fake comment.
 */
describe("the second-drawer guard over source built to hide one from it", () => {
  const offends = (src: string) => /aria-modal=|<dialog[\s>]/.test(src);
  const screen = `const OPENER = "/*";
export function Drawer() {
  return <aside aria-modal="true" className="lensDim" />;
}
/* the drawer's own note, and the close the fake opener was waiting for */
export const NAME = "drawer";
`;

  it("catches the drawer the naive strip had swallowed", () => {
    expect(offends(stripTsComments(screen)), "the guard must object to this file").toBe(true);
    expect(offends(naive(screen)), "the naive strip was supposed to leave nothing to object to").toBe(false);
  });

  it("a screen with no poison in it reads the same either way", () => {
    // The swap is not a behaviour change on the files this repo actually ships; it only removes
    // a way for those files to start lying later.
    const clean = `/* a note about aria-modal */\nexport function Ok() {\n  return <div />;\n}\n`;
    expect(stripTsComments(clean).replace(/\s+/g, " ")).toBe(naive(clean).replace(/\s+/g, " "));
    expect(offends(stripTsComments(clean))).toBe(false);
  });

  it("the console's own sources come through the scanner unharmed", () => {
    // The regression that would matter most is the quiet one: a scanner that ate real code would
    // make every absence-based guard in focus-return pass for free. Every brace, bracket and
    // parenthesis outside a comment has to survive, in the four files that guard names.
    const balance = (s: string) =>
      [..."{}[]()"].map((ch) => [ch, s.split(ch).length - 1] as const);
    for (const f of ["lens.tsx", "notices-tray.tsx", "overlay.tsx", "layout.tsx"]) {
      const path = `app/s/[secret]/console/${f}`;
      const out = stripTsComments(readFileSync(path, "utf8"));
      const pairs = Object.fromEntries(balance(out));
      expect(pairs["{"], `${f}: braces do not balance after stripping`).toBe(pairs["}"]);
      expect(pairs["["], `${f}: brackets do not balance after stripping`).toBe(pairs["]"]);
      expect(pairs["("], `${f}: parens do not balance after stripping`).toBe(pairs[")"]);
    }
  });

  it("an apostrophe in JSX text does not swallow the comments after it", () => {
    // overview-screen.tsx really contains one. Before the newline bail-out the scan treated it as
    // a string opener and ran to the next quote anywhere later in the file, so every comment in
    // between survived — and a guard reading this source then matched class names inside prose,
    // which is the exact failure these helpers exist to prevent.
    const src = [
      `const a = <p>the operator's note</p>;`,
      `/* a block comment that must go */`,
      `const keep = "SENTINEL_ONE";`,
      `// a line comment that must go`,
      `const also = "SENTINEL_TWO";`,
    ].join("\n");
    const out = stripTsComments(src);
    expect(out).toContain("SENTINEL_ONE");
    expect(out).toContain("SENTINEL_TWO");
    expect(out).not.toContain("must go");
  });

  it("a real string still spans to its closing quote on the same line", () => {
    const out = stripTsComments(`const s = "a /* not a comment */ b"; /* gone */`);
    expect(out).toContain("a /* not a comment */ b");
    expect(out).not.toContain("gone");
  });
});
