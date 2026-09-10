import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { pristineBootstrapSql } from "../scripts/bootstrap";
import { readMigrationFiles } from "../scripts/migrate";

it("ships the exact reviewed pristine installer for browser-only setup", () => {
  expect(existsSync("supabase/bootstrap.sql")).toBe(true);
  // The native suite executes this generator against a real empty database.
  // Keep the copyable browser artifact byte-identical, including every ledger hash.
  expect(readFileSync("supabase/bootstrap.sql", "utf8")).toBe(pristineBootstrapSql(readMigrationFiles()));
});

it("bounds the deliberate rebuild exception to reviewed SQL and its generated copy", () => {
  const properties = new Map(readFileSync("sonar-project.properties", "utf8").split(/\r?\n/)
    .filter(line => line.startsWith("sonar."))
    .map(line => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)] as const; }));
  const prefix = "sonar.issue.ignore.multicriteria";
  expect(properties.get(prefix)).toBe("migRebuild,bootstrapRebuild");
  expect([...properties.entries()].filter(([key]) => key.startsWith(`${prefix}.`))).toEqual([
    [`${prefix}.migRebuild.ruleKey`, "plsql:DeleteOrUpdateWithoutWhereCheck"],
    [`${prefix}.migRebuild.resourceKey`, "supabase/migrations/20260812000000_note_edges.sql"],
    [`${prefix}.bootstrapRebuild.ruleKey`, "plsql:DeleteOrUpdateWithoutWhereCheck"],
    [`${prefix}.bootstrapRebuild.resourceKey`, "supabase/bootstrap.sql"],
  ]);
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  expect(hash(readFileSync("supabase/migrations/20260812000000_note_edges.sql", "utf8")))
    .toBe("d6ac72924962c8e77a21af303d52960dbfc04ac25a95ea33e0897a3b35f1b3fd");
  // Every future migration is analyzed at source. The byte-parity test above forbids
  // changing only its generated copy. Wrapper-only SQL is frozen separately here:
  // changing this digest requires reviewing the scaffold, not accepting a new snapshot.
  expect(hash(pristineBootstrapSql(new Map())))
    .toBe("f1595a4cc6c5520b7f30ef5da11e13cf40ca769c98fa3ff71c30bb15841e84f0");
});
