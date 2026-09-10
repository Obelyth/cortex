import { describe, expect, it } from "vitest";
import { oversizedPageItems } from "../lib/inbox";
import { MAX_PAGE_BYTES } from "../lib/digest";

const big = (n: number) => "x".repeat(n);

describe("oversizedPageItems — the trigger the splitter never had", () => {
  it("raises a page over the threshold and names the command that fixes it", () => {
    const files = new Map([["projects/harbor.md", big(MAX_PAGE_BYTES + 1)]]);
    const [item] = oversizedPageItems(files);
    expect(item.kind).toBe("oversized-page");
    expect(item.loc).toBe("projects/harbor.md");
    expect(item.action).toContain("scripts/split-project-page.ts projects/harbor.md");
  });

  it("is silent at the threshold — the bound is a ceiling, not a target", () => {
    expect(oversizedPageItems(new Map([["projects/a.md", big(MAX_PAGE_BYTES)]]))).toEqual([]);
  });

  // A log is a dated record that is never split, and the router already collapses the whole of
  // log/ into one row per month, so its size costs the boot call nothing.
  it("never raises a day log, however long the day was", () => {
    const files = new Map([["log/2026-09-04.md", big(MAX_PAGE_BYTES * 4)]]);
    expect(oversizedPageItems(files)).toEqual([]);
  });

  it("measures BYTES, not characters — a page of multi-byte prose is not under budget by accident", () => {
    // "…" is three bytes and one character. A length check would call this comfortably small.
    const text = "…".repeat(MAX_PAGE_BYTES / 2);
    expect(text.length).toBeLessThan(MAX_PAGE_BYTES);
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(MAX_PAGE_BYTES);
    expect(oversizedPageItems(new Map([["notes/a.md", text]]))).toHaveLength(1);
  });

  it("orders by path so the queue is stable between runs", () => {
    const files = new Map([
      ["projects/z.md", big(MAX_PAGE_BYTES + 10)],
      ["notes/a.md", big(MAX_PAGE_BYTES + 10)],
    ]);
    expect(oversizedPageItems(files).map((i) => i.loc)).toEqual(["notes/a.md", "projects/z.md"]);
  });
});

describe("oversizedPageItems — history parts are the splitter's output", () => {
  it("never raises a history part, which the splitter cannot cut smaller", () => {
    // Measured on the live corpus the day this check was written: one part sat 25 bytes over the
    // bound because a section is never cut in half. Irreducible, so not an item.
    const files = new Map([["history/harbor-2026-08-3.md", "x".repeat(MAX_PAGE_BYTES + 25)]]);
    expect(oversizedPageItems(files)).toEqual([]);
  });

  it("still raises the status page that history parts were cut from", () => {
    const files = new Map([["projects/harbor.md", "x".repeat(MAX_PAGE_BYTES + 25)]]);
    expect(oversizedPageItems(files)).toHaveLength(1);
  });
});
