import { describe, expect, it } from "vitest";
import { summariseLifecycle } from "../lib/lifecycle";

describe("summariseLifecycle", () => {
  it("reports the temperature split with percentages", () => {
    const out = summariseLifecycle(
      [{ temperature: "hot", n: 10 }, { temperature: "warm", n: 30 }, { temperature: "cold", n: 60 }],
      []
    );
    expect(out).toContain("corpus 100 scored notes");
    expect(out).toContain("cold 60 (60%)");
  });

  it("lists candidates in full, sorted, with their reason", () => {
    const out = summariseLifecycle(
      [{ temperature: "cold", n: 2 }],
      [
        { path: "notes/z.md", reason: "cold · never read · unchanged 200 days" },
        { path: "notes/a.md", reason: "cold · never read · unchanged 400 days" },
      ]
    );
    const lines = out.split("\n");
    expect(lines[1]).toContain("awaiting a decision: 2");
    expect(lines[2]).toContain("notes/a.md");
    expect(lines[3]).toContain("notes/z.md");
  });

  it("says why an empty list is the expected state, not a failure", () => {
    const out = summariseLifecycle([{ temperature: "hot", n: 1 }], []);
    expect(out).toContain("read even once is never nominated");
  });

  it("does not divide by zero on an unscored corpus", () => {
    expect(summariseLifecycle([], [])).toContain("corpus 0 scored notes");
  });
});
