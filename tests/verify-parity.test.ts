/**
 * The verifier's two implementations must agree, or the eval's numbers describe a function the
 * server does not run — and they diverged in the UNSAFE direction: U+FEFF was whitespace to
 * JavaScript but not to Python, so production accepted quotes the eval scored as unproven.
 *
 * Two layers, because cross-repo parity cannot be enforced from cortex's CI alone:
 *
 *   1. A pinned golden of normalise() outputs. Always runs, including in CI, and fails the
 *      moment the TypeScript side drifts.
 *   2. The live differential against brain/tools/eval/verify_citation.py. Needs the clone, so
 *      it is skipped in CI — but skipped VISIBLY, never silently dropped from the count.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalise, verifyQuote } from "../lib/verify";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRAIN = process.env.BRAIN_DIR ?? path.resolve(HERE, "../../brain");
const PY = path.join(BRAIN, "tools", "eval", "verify_citation.py");

/** Every shape the audit found, plus the ones that must NOT collapse into each other. */
export const CASES = [
  "brain_ask",
  "brainask",
  "top-1 > 58.4%",
  "top-1 58.4%",
  "notes/*.md",
  "notes/.md",
  "#7 open",
  "7 open",
  "template > GitHub > hook > CLAUDE.md",
  "template GitHub hook CLAUDE.md",
  "ADMIN_PASSWORD",
  "ADMINPASSWORD",
  "**bold** text here",
  "bold text here",
  // Bold that swallows its trailing punctuation — this brain's dominant style, and the shapes
  // that actually diverged between the two implementations while this golden stayed green.
  // The list only covered `**bold** text`, where the marker follows a letter, so it could not
  // see the disagreement. A golden that omits the interesting cases is not a golden.
  "**58.4%**, MRR 0.727",
  "58.4%, MRR 0.727",
  "**Label:** value",
  "Label: value",
  "**Sentence ends here.** next",
  "Sentence ends here. next",
  "**café** text",
  "café text",
  "`main`/`dev` flow",
  "main/dev flow",
  "`code` span here",
  "code span here",
  "agents/*.md",
  "agents/.md",
  "2 * 3 = 6",
  "# heading line of text",
  "> quoted line of text",
  "- bullet line of text",
  "1. numbered line of text",
  "a​b sufficiently long",
  "Production is﻿still dark",
  "Production is still dark",
  "﻿leading bom text here",
  "soft­hyphen padded text",
  "softhyphen padded text",
  "  spaced   out \t quote  ",
  "café — naïve – text",
  "line one\nline two joined",
  "　ideographic space",
  " nbsp padded text here",
];

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
    // The regression this golden failed to catch. The CLOSE rule once named its ALLOWED
    // predecessors, which excluded `.` `:` `%` and accented letters — 259 of 727 markdown
    // blocks in the live brain stopped verifying when a reader dropped the markdown, and the
    // two implementations silently disagreed for a while because none of these were pinned.
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
    expect(normalise(" nbsp padded text here")).toBe("nbsp padded text here");
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
    "| Ledger | confirm each time | not fixed |",
    "| Harbor   | see project page  | no dev branch |",
  ].join("\n");

  it("joins soft-wrapped lines inside one paragraph", () => {
    expect(verifyQuote(doc, "gamma delta epsilon zeta").verified).toBe(true);
  });

  it("refuses a quote welded across a blank line — the splice with no artefact at all", () => {
    // ~80,000 such spans existed in the live brain. A paragraph break and an intra-paragraph
    // sentence space are the same character once whitespace is collapsed, so this splice left
    // nothing to notice. It is caught by structure, not by inspection.
    const v = verifyQuote(doc, "epsilon zeta mu nu xi");
    expect(v.verified).toBe(false);
    expect(v.reason).toMatch(/spans a paragraph, list or section boundary/);
  });

  it("refuses a quote welded across a heading, which no longer even matches the file", () => {
    // 192 of those spans crossed a heading, where stripping `#` everywhere deleted the only
    // marker a section had been left. Line-leading-only stripping keeps the heading TEXT, so
    // the weld now fails the whole-file test too.
    const v = verifyQuote(doc, "mu nu xi omicron eta theta");
    expect(v.verified).toBe(false);
    expect(v.reason).toBe("NOT FOUND in the cited file");
  });

  it("refuses a quote welded across two table rows", () => {
    // The real case: notes/branch-policy.md, where welding rows moves one project's branch
    // policy onto another — in a note whose entire purpose is not getting that wrong.
    const v = verifyQuote(doc, "not fixed | Harbor | see project page");
    expect(v.verified).toBe(false);
  });

  it("reports the line and heading the match came from", () => {
    const v = verifyQuote(doc, "eta theta iota kappa");
    expect(v.line).toBe(10);
    expect(v.heading).toBe("Heading two");
  });
});

// --------------------------------------------------------------- cross-language

const havePy = existsSync(PY);

if (!havePy) {
  describe.skip("TS/PY differential over the live verifier", () => {
    it(`SKIPPED: needs brain/tools/eval/verify_citation.py at ${PY} — set BRAIN_DIR`, () => {});
  });
}

if (havePy) describe("TS/PY differential over the live verifier", () => {
  it("agrees with verify_citation.py on every normalise case", () => {
    const script = [
      "import json,sys",
      `sys.path.insert(0, ${JSON.stringify(path.dirname(PY))})`,
      "from verify_citation import normalise",
      "cases=json.loads(sys.stdin.read())",
      "print(json.dumps([normalise(c) for c in cases]))",
    ].join("\n");
    const out = execFileSync("python3", ["-c", script], {
      input: JSON.stringify(CASES),
      encoding: "utf8",
    });
    expect(JSON.parse(out)).toEqual(CASES.map(normalise));
  });

  it("agrees on real (file, quote) pairs from the live brain, splices included", () => {
    const rel = "notes/beacon-rollout.md";
    const file = path.join(BRAIN, rel);
    if (!existsSync(file)) return;
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 30);
    const quotes = [...lines.slice(0, 6).map((l) => l.trim()), `${lines[0].trim()} ${lines[4].trim()}`];
    const script = [
      "import json,sys",
      `sys.path.insert(0, ${JSON.stringify(path.dirname(PY))})`,
      "from pathlib import Path",
      "from verify_citation import verify",
      "qs=json.loads(sys.stdin.read())",
      `print(json.dumps([verify(Path(${JSON.stringify(BRAIN)}), ${JSON.stringify(rel)}, q)[0] for q in qs]))`,
    ].join("\n");
    const py = JSON.parse(
      execFileSync("python3", ["-c", script], { input: JSON.stringify(quotes), encoding: "utf8" })
    ) as boolean[];

    const body = readFileSync(file, "utf8");
    expect(quotes.map((q) => verifyQuote(body, q).verified)).toEqual(py);
  });
});
