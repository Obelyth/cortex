import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { pristineBootstrapSql } from "../scripts/bootstrap";
import { readMigrationFiles } from "../scripts/migrate";

it("ships the exact reviewed pristine installer for browser-only setup", () => {
  expect(existsSync("supabase/bootstrap.sql")).toBe(true);
  // The native suite executes this generator against a real empty database.
  // Keep the copyable browser artifact byte-identical, including every ledger hash.
  expect(readFileSync("supabase/bootstrap.sql", "utf8")).toBe(pristineBootstrapSql(readMigrationFiles()));
});
