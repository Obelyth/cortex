/**
 * Pinned golden of the verifier's normalise() and block scoping. The reference deployment
 * keeps a second layer — a live differential against an independent Python implementation —
 * because the two once diverged in the UNSAFE direction: U+FEFF was whitespace to JavaScript
 * but not to Python, so production accepted quotes the eval scored as unproven. This golden
 * is the layer that needs no clone: it fails the moment the TypeScript side drifts.
 */
import { describe, expect, it } from "vitest";
import { normalise, verifyQuote } from "../lib/verify";

describe("normalise — pinned golden", () => {
  it("distinguishes every pair the old blanket strip collapsed", () => {
    // Each of these was a single string under `[*_`>#]+` applied globally, which is how a
    // measurement became an inequality and an identifier got silently renamed.
    const pairs: Array<[string, string]> = [
      ["brain_ask", "brainask"],
      ["top-1 > 58.4%", "top-1 58.4%"],
      ["notes/*.md", "notes/.md"],
      ["#7 open", "7 open"],
      ["template > GitHub > hook > CLAUDE.md", "template GitHub hook CLAUDE.md"],
      ["ADMIN_PASSWORD", "ADMINPASSWORD"],
    ];
    for (const [a, b] of pairs) expect(normalise(a)).not.toBe(normalise(b));
  });

  it("folds bold that swallows its own trailing punctuation", () => {
    // The regression the first golden failed to catch. The CLOSE rule once named its ALLOWED
    // predecessors, which excluded `.` `:` `%` and accented letters — in the reference brain,
    // 259 of 727 markdown blocks stopped verifying when a reader dropped the markdown, and
    // the two implementations silently disagreed because none of these were pinned.
    expect(normalise("**58.4%**, MRR 0.727")).toBe(normalise("58.4%, MRR 0.727"));
    expect(normalise("**Label:** value")).toBe(normalise("Label: value"));
    expect(normalise("**Sentence ends here.** next")).toBe(normalise("Sentence ends here. next"));
    expect(normalise("**café** text")).toBe(normalise("café text"));
    expect(normalise("`main`/`dev` flow")).toBe(normalise("main/dev flow"));
  });

  it("does NOT fold an asterisk that is part of a path or an operator", () => {
    // Why the predecessor class excludes `/` rather than allowing everything.
    expect(normalise("agents/*.md")).not.toBe(normalise("agents/.md"));
    expect(normalise("2 * 3 = 6")).toBe("2 * 3 = 6");
  });

  it("still folds what a reader may legitimately drop when quoting", () => {
    expect(normalise("**bold** text here")).toBe(normalise("bold text here"));
    expect(normalise("`code` span here")).toBe(normalise("code span here"));
    expect(normalise("# heading line of text")).toBe(normalise("heading line of text"));
    expect(normalise("> quoted line of text")).toBe(normalise("quoted line of text"));
    expect(normalise("- bullet line of text")).toBe(normalise("bullet line of text"));
    expect(normalise("  spaced   out \t quote  ")).toBe("spaced out quote");
    // Hard-wrapped prose is joined — brain notes are wrapped, so honest quotes depend on it.
    expect(normalise("line one\nline two joined")).toBe("line one line two joined");
  });

  it("deletes zero-width characters instead of folding them to a space", () => {
    // Folding widened matches; U+FEFF in particular was \s in JS and not in Python, so the
    // server was the more permissive of the two.
    expect(normalise("a​b sufficiently long")).toBe("ab sufficiently long");
    expect(normalise("Production is﻿still dark")).toBe("Production isstill dark");
    expect(normalise("soft­hyphen padded text")).toBe("softhyphen padded text");
    expect(normalise("﻿leading bom text here")).toBe("leading bom text here");
  });

  it("treats the exotic space characters as space, in both languages", () => {
    expect(normalise("　ideographic space")).toBe("ideographic space");
    expect(normalise(" nbsp padded text here")).toBe("nbsp padded text here");
  });
});

describe("block scoping", () => {
  const doc = [
    "# Heading one",
    "",
    "alpha beta gamma delta",
    "epsilon zeta",
    "",
    "mu nu xi omicron",
    "",
    "## Heading two",
    "",
    "eta theta iota kappa",
    "",
    "| Aurora | confirm each time | not fixed |",
    "| Beacon | see project page  | no dev branch |",
  ].join("\n");

  it("joins soft-wrapped lines inside one paragraph", () => {
    expect(verifyQuote(doc, "gamma delta epsilon zeta").verified).toBe(true);
  });

  it("refuses a quote welded across a blank line — the splice with no artefact at all", () => {
    // A paragraph break and an intra-paragraph sentence space are the same character once
    // whitespace is collapsed, so this splice leaves nothing to notice. It is caught by
    // structure, not by inspection.
    const v = verifyQuote(doc, "epsilon zeta mu nu xi");
    expect(v.verified).toBe(false);
    expect(v.reason).toMatch(/spans a paragraph, list or section boundary/);
  });

  it("refuses a quote welded across a heading, which no longer even matches the file", () => {
    // Stripping `#` everywhere deleted the only marker a section had been left.
    // Line-leading-only stripping keeps the heading TEXT, so the weld now fails the
    // whole-file test too.
    const v = verifyQuote(doc, "mu nu xi omicron eta theta");
    expect(v.verified).toBe(false);
    expect(v.reason).toBe("NOT FOUND in the cited file");
  });

  it("refuses a quote welded across two table rows", () => {
    // Welding rows moves one project's policy onto another — in a note whose entire purpose
    // is not getting exactly that wrong.
    const v = verifyQuote(doc, "not fixed | Beacon | see project page");
    expect(v.verified).toBe(false);
  });

  it("reports the line and heading the match came from", () => {
    const v = verifyQuote(doc, "eta theta iota kappa");
    expect(v.line).toBe(10);
    expect(v.heading).toBe("Heading two");
  });
});
