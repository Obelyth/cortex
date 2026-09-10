import { expect, it } from "vitest";
import { jsonbTextBytes, type EdgeRow } from "../lib/edges";

/**
 * edges_rebuild_v3 refuses a payload whose octet_length(edges::text) exceeds 16 MiB, and jsonb
 * text is not JSON.stringify text: PostgreSQL renders `{"k": v, "k": v}` and `[a, b]`, one space
 * after every colon and comma. The client-side cap must count the rendering the database will
 * measure, or it admits a payload the database throws back after the upload.
 */
it("counts an edge the way octet_length(edges::text) will, array separator included", () => {
  const row: EdgeRow = { src: "notes/a.md", dst: "notes/b.md", kind: "link", weight: 1, evidence: "[[b]]" };
  // jsonb orders keys shortest-first; the byte count does not depend on the order.
  const asJsonb = `{"dst": "notes/b.md", "src": "notes/a.md", "kind": "link", "weight": 1, "evidence": "[[b]]"}`;
  expect(jsonbTextBytes(row)).toBe(Buffer.byteLength(asJsonb) + ", ".length);
  expect(jsonbTextBytes(row)).toBeGreaterThan(Buffer.byteLength(JSON.stringify(row)) + 1);
});

it("measures bytes, not characters, so a non-ASCII evidence string is not undercounted", () => {
  const row: EdgeRow = { src: "notes/ä.md", dst: "notes/b.md", kind: "tag", weight: 2, evidence: "café" };
  const asJsonb = `{"dst": "notes/b.md", "src": "notes/ä.md", "kind": "tag", "weight": 2, "evidence": "café"}`;
  expect(jsonbTextBytes(row)).toBe(Buffer.byteLength(asJsonb) + 2);
});
