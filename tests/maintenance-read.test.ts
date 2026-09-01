import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";

/**
 * maintenance-read — the one bit of information the server cannot derive, and the SQL that
 * consumes it.
 *
 * The coaccess derivation calls two notes related when they were served in the same clock hour
 * often enough. That inference is only sound over reads a session CHOSE. The nightly
 * groundskeeper does eight to twelve brain_read calls inside one hour over overlapping page
 * sets, and it produced exactly the pairs the inbox then asked the operator to review — the
 * graph learning a cron job's traversal order and asking to have it written down. Boot and
 * handoff rows were excluded for the same shape; this third one is invisible to the server,
 * because currentSurface() reports `terminal` for the sweep and `terminal` for a real session.
 *
 * Two halves have to agree for the fix to work, and they live in different languages: the tool
 * decides which string to log, the migration decides which strings to drop. So the interesting
 * assertions here are the DERIVED ones — the mode brain_read really logs, read off the real
 * handler, checked against the exclusion list really parsed out of the migration that really
 * wins. A rename on either side breaks this file rather than quietly re-polluting the graph.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

// Spread the real module: tools.ts also imports MAX_WRITE_CHARS from here, and a factory that
// lists only the functions would hand the schema an undefined ceiling at registration.
vi.mock("../lib/brain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/brain")>()),
  readNote: vi.fn(async (p: string) => `# ${p}\n\nthe note text`),
  capture: vi.fn(),
  getContext: vi.fn(),
  validatePath: vi.fn(),
  writeNote: vi.fn(),
}));

import { registerTools } from "../lib/tools";
import { __setStore, type AccessRow, type MirrorStore } from "../lib/mirror";

// ---------------------------------------------------------------------------
// The real registrations, so the real zod schema and the real handler run —
// the harness tests/hard-surface.test.ts uses, and for the same reason.
// ---------------------------------------------------------------------------
interface Captured {
  config: { description?: string; inputSchema?: Record<string, z.ZodTypeAny> };
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
}

function captureTools(guest: boolean): Map<string, Captured> {
  const out = new Map<string, Captured>();
  const fake = {
    registerTool(name: string, config: Captured["config"], handler: Captured["handler"]) {
      out.set(name, { config, handler });
    },
  };
  registerTools(fake as unknown as McpServer, { guest });
  return out;
}

const TRUSTED = captureTools(false);
const GUEST = captureTools(true);
const brainRead = TRUSTED.get("brain_read")!;
const readSchema = z.object(brainRead.config.inputSchema ?? {});

/** Run the real brain_read handler and return the row lib/access actually recorded. */
async function readAndCaptureRow(args: Record<string, unknown>) {
  const rows: AccessRow[] = [];
  __setStore({
    head: async () => null,
    all: async () => [],
    paths: async () => [],
    apply: async () => true,
    access: async (r: AccessRow[]) => void rows.push(...r),
    scores: async () => null,
  } satisfies MirrorStore);
  const res = await brainRead.handler(args);
  await vi.waitFor(() => expect(rows).toHaveLength(1));
  return { row: rows[0], text: res.content.map((c) => c.text).join("\n"), isError: res.isError };
}

afterEach(() => {
  __setStore(undefined);
});

// ---------------------------------------------------------------------------
// The effective definition of edges_rebuild: the LAST migration in filename
// order that defines the function at all. Derived rather than named, because
// naming the file is how the next restating migration gets tested by nobody.
// ---------------------------------------------------------------------------
const MIG_DIR = path.join(HERE, "../supabase/migrations");
const DEFINES = /create\s+(?:or\s+replace\s+)?function\s+edges_rebuild\s*\(/;
const definers = readdirSync(MIG_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .filter((f) => DEFINES.test(readFileSync(path.join(MIG_DIR, f), "utf8")));
const effectiveFile = definers[definers.length - 1];
const effectiveSql = readFileSync(path.join(MIG_DIR, effectiveFile), "utf8");

/**
 * Every `where mode ...` filter applied to note_access in the given SQL, as a set of excluded
 * modes. Both spellings the file has ever used are parsed, so a rewrite back to the single-mode
 * `<>` form is caught as a NARROWER filter rather than read as no filter at all.
 */
function excludedModes(sql: string): string[][] {
  const out: string[][] = [];
  for (const m of sql.matchAll(/from note_access where mode not in \(([^)]*)\)/g)) {
    out.push(m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")));
  }
  for (const m of sql.matchAll(/from note_access where mode <> '([^']+)'/g)) {
    out.push([m[1]]);
  }
  return out;
}

const filters = excludedModes(effectiveSql);

describe("brain_read's maintenance flag", () => {
  it("logs mode 'read' when the flag is absent — the honest default for every existing caller", async () => {
    const { row } = await readAndCaptureRow({ path: "projects/harbor.md" });
    expect(row).toMatchObject({ path: "projects/harbor.md", tool: "brain_read", mode: "read" });
  });

  it("logs mode 'read' when the flag is explicitly false", async () => {
    const { row } = await readAndCaptureRow({ path: "projects/harbor.md", maintenance: false });
    expect(row.mode).toBe("read");
  });

  it("logs mode 'maintenance' when the flag is true", async () => {
    const { row } = await readAndCaptureRow({ path: "projects/harbor.md", maintenance: true });
    expect(row).toMatchObject({ path: "projects/harbor.md", tool: "brain_read", mode: "maintenance" });
  });

  it("changes NOTHING a caller can observe except the logged mode", async () => {
    // The whole design rests on the sweep reading the same bytes through the same gate. If a
    // maintenance read ever returned less, callers would stop setting the flag to get the text.
    const plain = await readAndCaptureRow({ path: "projects/harbor.md" });
    const sweep = await readAndCaptureRow({ path: "projects/harbor.md", maintenance: true });
    expect(sweep.text).toBe(plain.text);
    expect(sweep.isError).toBe(plain.isError);
    expect({ ...sweep.row, mode: null }).toEqual({ ...plain.row, mode: null });
  });

  it("accepts the old one-argument call shape, and rejects a non-boolean flag", () => {
    expect(readSchema.safeParse({ path: "projects/harbor.md" }).success).toBe(true);
    expect(readSchema.safeParse({ path: "projects/harbor.md", maintenance: true }).success).toBe(true);
    expect(readSchema.safeParse({ path: "projects/harbor.md", maintenance: "yes" }).success).toBe(false);
  });

  it("tells a caller in the description what the flag MEANS, not just that it exists", () => {
    // A flag whose docs say "set for maintenance" teaches nobody when to set it. The words that
    // have to survive an edit are the ones that name the consequence.
    const doc = `${brainRead.config.description ?? ""} ${
      brainRead.config.inputSchema?.maintenance?.description ?? ""
    }`;
    expect(doc).toMatch(/automated sweep/i);
    expect(doc).toMatch(/not real reading|rather than real reading/i);
    expect(doc).toMatch(/co-access/i);
    expect(doc).toMatch(/exclud/i);
  });
});

describe("the effective edges_rebuild definition", () => {
  it("is a restating migration, never an edit to an applied one", () => {
    // The runner keys its ledger on filename+checksum: editing an applied file leaves the
    // database on the old definition while the ledger calls itself current.
    expect(effectiveFile).toBe("20260812040000_coaccess_fanout_cap.sql");
    expect(effectiveSql).toMatch(/create or replace function edges_rebuild/);
    expect(definers.length).toBeGreaterThan(1);
  });

  it("reads note_access through one filtered source that both sides of the join share", () => {
    // This asserted exactly two filters, one per side of the self-join, and that they matched.
    // The duplication WAS the hazard it guarded: two copies of a filter is one forgotten edit
    // away from a side that filters nothing. 20260812040000 states it once, in a CTE both sides
    // select from, so "both sides agree" became structural instead of checked. What still has to
    // hold is the part that actually protects the graph, and it is now stronger: every read of
    // note_access in the winning migration is filtered, and all of them agree.
    expect(filters.length).toBeGreaterThanOrEqual(1);
    for (const f of filters) expect(f).toEqual(filters[0]);
    // No unfiltered read can sneak back in — the case the length-2 assertion could not see.
    expect([...effectiveSql.matchAll(/from note_access(?! where mode)/g)]).toHaveLength(0);
    // And the pairing really is that shared source joined to itself, not two fresh scans.
    expect(effectiveSql).toMatch(/from eligible a\s+join eligible b on a\.w = b\.w/);
  });

  it("excludes exactly boot, handoff and maintenance", () => {
    // Pinned deliberately. Widening this set silently drops real co-reads; narrowing it silently
    // re-pollutes the graph with rows nothing chose. Either way it should be a red build and a
    // conscious edit to this line, not a surprise in next month's inbox.
    expect([...filters[0]].sort()).toEqual(["boot", "handoff", "maintenance"]);
  });

  it("drops the mode a maintenance read logs, and keeps the mode a real read logs", async () => {
    // The cross-language join: the string the TypeScript writes, checked against the strings the
    // SQL drops. Rename either side and this fails.
    const sweep = await readAndCaptureRow({ path: "projects/harbor.md", maintenance: true });
    const real = await readAndCaptureRow({ path: "projects/harbor.md" });
    expect(filters[0]).toContain(sweep.row.mode);
    expect(filters[0]).not.toContain(real.row.mode);
  });

  it("says in its own evidence which rows it left out", () => {
    // The evidence string is what the console and the inbox show the operator. A weight computed
    // over a filtered log must disclose the filter, or the number reads as the whole log.
    expect(effectiveSql).toContain("boot/handoff/maintenance rows and windows over");
    expect(effectiveSql).toContain("notes excluded");
  });

  it("discards windows too broad for a pair inside them to mean anything", () => {
    // The caller-declared flag only works if the caller remembers. Every hand-maintained
    // declaration in this system has rotted the same silent way — the healthcheck's hardcoded
    // tool count, the settings.json allow-list. So the server enforces a bound it can see for
    // itself: a window of n notes yields n*(n-1)/2 pairs and argues equally for all of them, so
    // the broadest windows carry the least information per pair while dominating the output by
    // count. Measured on a 12-note sweep repeated five nights against one genuine pair: 67
    // coaccess edges, 66 of them noise. With the cap: 1 edge, the real one.
    expect(effectiveSql).toMatch(/fanout_cap\s+constant\s+int\s*:=\s*\d+;/);
    expect(effectiveSql).toMatch(/group by w having count\(\*\) <= fanout_cap/);
    // The cap must sit above a focused reading session and below the nightly sweep's 8-12.
    const cap = Number(/fanout_cap\s+constant\s+int\s*:=\s*(\d+);/.exec(effectiveSql)![1]);
    expect(cap).toBeGreaterThanOrEqual(5);
    expect(cap).toBeLessThan(8);
    // And it discloses itself, for the same reason the exclusions do: a weight computed over a
    // filtered log that does not name the filter reads as the whole log.
    expect(effectiveSql).toContain("|| fanout_cap");
  });

  it("leaves the rest of the rebuild alone — this migration is one filter, not a rewrite", () => {
    // Everything the earlier migrations argued for is still here: the CAS on the mirror head,
    // the full replace, the two-window floor, and endpoints pinned to live notes.
    expect(effectiveSql).toContain("if mirror_head is distinct from new_head then");
    expect(effectiveSql).toContain("delete from note_edges where true");
    expect(effectiveSql).toContain("date_trunc('hour', at)");
    expect(effectiveSql).toMatch(/having count\(\*\) >= 2/);
    expect(effectiveSql).toMatch(/exists \(select 1 from notes/);
    expect(effectiveSql).toMatch(/set search_path = public, pg_catalog/);
  });
});

describe("the guest door", () => {
  it("does not register brain_read at all, so no guest can flag its reads invisible", () => {
    // The flag is caller-declared, which means it is only as trustworthy as the caller. That is
    // fine for the trusted door and would not be for an untrusted one — a guest able to mark its
    // own reads as maintenance could walk the corpus without leaving co-access evidence. It
    // cannot, because it never gets the tool: shared on ask, not openly shared.
    expect([...GUEST.keys()].sort()).toEqual(["brain_ask", "brain_propose"]);
    expect(GUEST.has("brain_read")).toBe(false);
    // And the mode a guest's reads DO carry is not the excluded one.
    expect(filters[0]).not.toContain("guest");
  });
});
