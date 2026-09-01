import { describe, expect, it } from "vitest";
import { parseFrontmatter, applyDecays } from "../lib/frontmatter";

/**
 * `decays: false` takes a note off the verification-stamp clock.
 *
 * The check treated every stamped note alike, and the notes are not alike: "MEGAsync was removed
 * on 2026-07-26" cannot stop being true, while a runbook describing how a machine is configured
 * decays the moment the machine changes. Six of seven inbox findings were the first kind, which is
 * how the one that mattered — a recovery runbook with an unmitigated risk — got buried.
 *
 * The direction of failure is the whole design. Being watched when you need not be is noise;
 * NOT being watched when you should be is a stale fact answered as current. So every ambiguous
 * input has to land on "watched".
 */
describe("decays", () => {
  it("defaults to undefined, which the health check reads as still-watched", () => {
    expect(parseFrontmatter('---\ndescription: "x"\n---\n\nbody').decays).toBeUndefined();
    expect(parseFrontmatter("no frontmatter here").decays).toBeUndefined();
  });

  it("only an explicit, unambiguous false opts a note out", () => {
    for (const v of ["false", "no", "never", "False", "NO"]) {
      expect(parseFrontmatter(`---\ndecays: ${v}\n---\n\nx`).decays, v).toBe(false);
    }
    for (const v of ["true", "yes"]) {
      expect(parseFrontmatter(`---\ndecays: ${v}\n---\n\nx`).decays, v).toBe(true);
    }
  });

  it("BUG GUARD: a value it does not understand leaves the note watched, never unwatched", () => {
    // "maybe", a typo, a half-written edit. Each one must fail toward being checked -- a loose
    // parse here silently removes a note from the queue and nothing ever says so.
    for (const v of ["maybe", "flase", "0", "null", "", "sometimes", "false-ish"]) {
      expect(parseFrontmatter(`---\ndecays: ${v}\n---\n\nx`).decays, v).not.toBe(false);
    }
  });

  it("ignores an indented decays, which belongs to a nested block", () => {
    const text = '---\ndescription: "x"\nmetadata:\n  decays: false\n---\n\nbody';
    expect(parseFrontmatter(text).decays).toBeUndefined();
  });

  it("applyDecays adds the key without touching the body", () => {
    const text = '---\ndescription: "x"\ntags: [a, b]\n---\n\n# Title\n\n_Facts last verified 2026-07-01_\n';
    const out = applyDecays(text, false);
    expect(parseFrontmatter(out).decays).toBe(false);
    // The body is what citations are proven against. A function that quiets the inbox does not
    // get to alter the text being cited.
    expect(parseFrontmatter(out).body).toBe(parseFrontmatter(text).body);
    expect(parseFrontmatter(out).description).toBe("x");
    expect(parseFrontmatter(out).tags).toEqual(["a", "b"]);
  });

  it("opens a frontmatter block when the note has none, keeping the text verbatim", () => {
    const out = applyDecays("# Bare note\n\nbody text\n", false);
    expect(parseFrontmatter(out).decays).toBe(false);
    expect(out.endsWith("# Bare note\n\nbody text\n")).toBe(true);
  });

  it("is idempotent, and rewrites in place rather than adding a second key", () => {
    const once = applyDecays('---\ndescription: "x"\n---\n\nbody', false);
    expect(applyDecays(once, false)).toBe(once);

    const flipped = applyDecays(once, true);
    expect((flipped.match(/^decays:/gm) ?? []).length).toBe(1);
    expect(parseFrontmatter(flipped).decays).toBe(true);
  });
});
