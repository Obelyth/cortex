import { afterEach, describe, expect, it, vi } from "vitest";
import { logNoteAccess } from "../lib/access";
import { __setStore, type AccessRow, type MirrorStore } from "../lib/mirror";

/**
 * lib/access.ts had no test file, and it is the module MOST able to break without anyone
 * noticing: it is designed to fail silently by contract ("an OBSERVATION, never the product"),
 * and it is the sole source of the rows every temperature score is computed from.
 *
 * So a regression here — a wrong store shape, an always-empty paths array from a caller, an
 * after() that swallows the write — produces no test failure, no error, and no user-visible
 * symptom. It produces permanently undercounted reads feeding a downstream feature, which
 * surfaces months later as "why is everything cold". These tests pin both the happy path and
 * both silent guards.
 */
function recorder() {
  const rows: AccessRow[][] = [];
  const store = {
    head: async () => null,
    all: async () => [],
    paths: async () => [],
    apply: async () => true,
    access: async (r: AccessRow[]) => {
      rows.push(r);
    },
    scores: async () => null,
  } satisfies MirrorStore;
  return { rows, store };
}

afterEach(() => {
  __setStore(undefined);
  vi.restoreAllMocks();
});

describe("logNoteAccess", () => {
  it("writes one row per path, carrying tool and mode", async () => {
    const { rows, store } = recorder();
    __setStore(store);

    logNoteAccess(["projects/a.md", "notes/b.md"], "brain_corpus", "paths");
    await vi.waitFor(() => expect(rows).toHaveLength(1));

    expect(rows[0]).toHaveLength(2);
    expect(rows[0].map((r) => r.path)).toEqual(["projects/a.md", "notes/b.md"]);
    for (const row of rows[0]) {
      expect(row.tool).toBe("brain_corpus");
      expect(row.mode).toBe("paths");
      expect(typeof row.surface).toBe("string");
    }
  });

  it("writes nothing when the mirror is unconfigured", () => {
    // The zero-env deploy. Not an error state — the public product runs this way.
    __setStore(null);
    expect(() => logNoteAccess(["projects/a.md"], "brain_read", "read")).not.toThrow();
  });

  it("writes nothing for an empty path list", () => {
    // A listing served no note text, so there is nothing to record. The guard matters because a
    // caller that starts passing [] would otherwise write empty batches forever and look healthy.
    const { rows, store } = recorder();
    __setStore(store);
    logNoteAccess([], "brain_corpus", "listing");
    expect(rows).toEqual([]);
  });

  it("logs and swallows a store failure rather than surfacing it to the caller", async () => {
    // The contract: nothing that reads notes may fail because of the thing that observes the
    // reading. A rejected access write must reach the server log and go no further.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    __setStore({
      head: async () => null,
      all: async () => [],
      paths: async () => [],
      apply: async () => true,
      access: async () => {
        throw new Error("postgrest 503");
      },
      scores: async () => null,
    });

    expect(() => logNoteAccess(["projects/a.md"], "brain_ask", "guest")).not.toThrow();
    await vi.waitFor(() => expect(err).toHaveBeenCalled());
    expect(String(err.mock.calls[0][0])).toMatch(/\[access\] dropped 1 row/);
  });
});
