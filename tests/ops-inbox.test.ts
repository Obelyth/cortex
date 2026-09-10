import { describe, expect, it } from "vitest";
import { decisionItems, INBOX_LINES, inboxSummary, proposalTitle, sevTone } from "../lib/ops-inbox";
import type { TriageItem } from "../lib/health";
import type { Proposal } from "../lib/proposals";

const item = (sev: TriageItem["sev"], loc: string, title = "t"): TriageItem => ({ sev, title, loc, evidence: "e", why: "w", action: "a" });
const proposal = (id: string): Proposal => ({ id, ts: 0, path: "notes/x.md", mode: "append", content: "" });

describe("inboxSummary — three lines and a count, not the whole Attention screen", () => {
  it("counts triage and proposals separately and together", () => {
    const s = inboxSummary([item("warn", "a")], [proposal("p1"), proposal("p2")]);
    expect(s).toMatchObject({ count: 3, triage: 1, proposals: 2, more: 0 });
  });

  it("shows the most urgent first, then by location, and never more than the line budget", () => {
    const s = inboxSummary(
      [item("watch", "z"), item("crit", "m"), item("warn", "b"), item("warn", "a"), item("crit", "c")],
      []
    );
    expect(s.lines.map((l) => `${l.sev}:${l.loc}`)).toEqual(["crit:c", "crit:m", "warn:a"]);
    expect(s.lines).toHaveLength(INBOX_LINES);
    expect(s.more).toBe(2);
  });

  it("is honest at zero — no lines, no more, count 0", () => {
    expect(inboxSummary([], [])).toEqual({ count: 0, triage: 0, proposals: 0, lines: [], more: 0 });
  });

  it("carries only what a line needs to point at the finding", () => {
    const [line] = inboxSummary([item("crit", "notes/a.md", "Credential-shaped line")], []).lines;
    expect(line).toEqual({ sev: "crit", title: "Credential-shaped line", loc: "notes/a.md" });
  });
});

describe("sevTone — colour is a field, and watch is not a colour", () => {
  it.each([["crit", "crit"], ["warn", "warn"], ["watch", "paper"]] as const)("%s → %s", (sev, tone) => {
    expect(sevTone(sev)).toBe(tone);
  });
});

describe("decisionItems — the whole queue, proposals first, for the lens to open from", () => {
  it("leads with proposals, then the queue by severity and location, each with a unique id", () => {
    const items = decisionItems([item("watch", "z"), item("crit", "m"), item("warn", "a")], [proposal("p1")]);
    expect(items.map((i) => `${i.sev}:${i.loc}`)).toEqual(["proposal:client unstated → notes/x.md", "crit:m", "warn:a", "watch:z"]);
    expect(new Set(items.map((i) => i.id)).size).toBe(4);
  });

  it("carries the whole item, not a summary — the lens shows evidence, why and action", () => {
    const [d] = decisionItems([item("crit", "notes/a.md", "Credential-shaped line")], []);
    expect(d.kind).toBe("triage");
    if (d.kind === "triage") expect(d.item).toMatchObject({ evidence: "e", why: "w", action: "a" });
    expect(d.id).toBe("triage:danger:notes/a.md");
  });

  it("keeps two findings at one location apart", () => {
    const ids = decisionItems([item("warn", "notes/a.md"), item("warn", "notes/a.md")], []).map((i) => i.id);
    expect(ids).toEqual(["triage:danger:notes/a.md", "triage:danger:notes/a.md#1"]);
  });

  it("titles a proposal with its first line, cut for a row, and names the caller as a claim", () => {
    const p: Proposal = { ...proposal("p2"), client: "guest-a", content: `\n\n  ${"x".repeat(120)}\nsecond` };
    const [d] = decisionItems([], [p]);
    expect(d.title).toHaveLength(96);
    expect(d.title.endsWith("…")).toBe(true);
    expect(d.loc).toBe("guest-a → notes/x.md");
    expect(proposalTitle({ ...p, content: "" })).toBe("append → notes/x.md");
  });

  it("is honest at zero", () => {
    expect(decisionItems([], [])).toEqual([]);
  });
});
