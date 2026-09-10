import { describe, expect, it } from "vitest";
import { substringHits } from "./helpers/export-scan";

describe("export substring scan", () => {
  const patterns: Array<[string, string]> = [["sample private sentence", "synthetic-note"], ['quote "inside" text', "synthetic-quoted-note"]];
  it("finds embedded matches, reports the first line, and never returns matching content", () => {
    expect(substringHits([["fixture.ts", "header\n// prefix sample private sentence suffix\nsample private sentence"]], patterns)).toEqual([{file:"fixture.ts",line:2,origin:"synthetic-note"}]);
  });
  it("also scans escaped JSON and JavaScript strings without duplicates", () => {
    expect(substringHits([["fixture.json", JSON.stringify({text:'quote "inside" text'})]], patterns)).toEqual([{file:"fixture.json",line:1,origin:"synthetic-quoted-note"}]);
    expect(substringHits([["fixture.js", String.raw`\x73ample private sentence; sample private sentence`]], patterns)).toEqual([{file:"fixture.js",line:1,origin:"synthetic-note"}]);
  });
  it("matches literal substrings, including overlapping prefixes and short credentials", () => {
    expect(substringHits([["fixture", "aba 7294 ababa"]], [["aba","one"],["ababa","two"],["7294","three"]])).toEqual([{file:"fixture",line:1,origin:"one"},{file:"fixture",line:1,origin:"three"},{file:"fixture",line:1,origin:"two"}]);
  });
  it("refuses an empty pattern and handles empty sets", () => {
    expect(()=>substringHits([["fixture","text"]],[["","synthetic"]])).toThrow(/empty pattern/);
    expect(substringHits([["fixture","text"]],[])).toEqual([]);
  });
});
