import { describe, expect, it } from "vitest";
import { pendingMigrationItem, pendingMigrations, shippedMigrations } from "../lib/migrations";

describe("pendingMigrations — merged is not applied", () => {
  it("names every shipped file the ledger has no row for, in apply order", () => {
    const shipped = ["20260902120000_ops_ledger.sql", "20260812040000_coaccess_fanout_cap.sql", "20260806220000_temperature.sql"];
    const applied = ["20260806220000_temperature.sql"];
    expect(pendingMigrations(shipped, applied)).toEqual([
      "20260812040000_coaccess_fanout_cap.sql",
      "20260902120000_ops_ledger.sql",
    ]);
  });

  it("is empty when the ledger carries every file", () => {
    expect(pendingMigrations(["a.sql", "b.sql"], ["b.sql", "a.sql"])).toEqual([]);
  });

  // A ledger row for a file this build does not ship (an older checkout, a deleted file) is not
  // a finding: the question is only whether what shipped has landed.
  it("ignores ledger rows this build does not ship", () => {
    expect(pendingMigrations(["a.sql"], ["a.sql", "zzz_gone.sql"])).toEqual([]);
  });
});

describe("pendingMigrationItem — the trigger, with the command filled in", () => {
  it("is null when nothing is pending, so the queue stays quiet", () => {
    expect(pendingMigrationItem([])).toBeNull();
  });

  it("raises one warn item naming the file and the runner", () => {
    const item = pendingMigrationItem(["20260905100000_sync_apply_content_aware.sql"]);
    expect(item).toMatchObject({ sev: "warn", kind: "pending-migration" });
    expect(item?.title).toBe("A migration is merged but not applied");
    expect(item?.evidence).toContain("20260905100000_sync_apply_content_aware.sql");
    expect(item?.action).toContain("scripts/migrate.ts");
    expect(item?.action).toContain("--apply");
  });

  it("counts, and lists every file, when more than one is pending", () => {
    const item = pendingMigrationItem(["a.sql", "b.sql", "c.sql"]);
    expect(item?.title).toBe("3 migrations are merged but not applied");
    expect(item?.loc).toBe("supabase/migrations/a.sql +2 more");
    expect(item?.evidence).toContain("a.sql, b.sql, c.sql");
  });
});

describe("shippedMigrations — read from the directory this build carries", () => {
  it("lists the real migration files, sorted, .sql only", () => {
    const files = shippedMigrations();
    expect(files).not.toBeNull();
    expect(files!.every((f) => f.endsWith(".sql"))).toBe(true);
    expect(files).toEqual([...files!].sort());
    expect(files).toContain("20260905100000_sync_apply_content_aware.sql");
  });

  it("is null, not empty, for a root with no migrations directory", () => {
    expect(shippedMigrations("/nonexistent-root-for-this-test")).toBeNull();
  });
});
