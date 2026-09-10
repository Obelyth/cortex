import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The write rule that lets a note go cold. A full sync must never re-stamp a note it did not
 * change; the previous coalesce let any non-null date win, and with the head date sent for every
 * row the whole corpus was re-warmed on every rebuild (0 of 156 cold, 2026-09-04). This test
 * reads the NEWEST migration that defines sync_apply, so a later redefinition that drops the rule
 * fails here rather than in production a month later.
 */
const DIR = join(process.cwd(), "supabase", "migrations");
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const defining = files.filter((f) => /create or replace function sync_apply\b/.test(readFileSync(join(DIR, f), "utf8")));
const newest = defining[defining.length - 1];
const sql = readFileSync(join(DIR, newest), "utf8");

describe("sync_apply — content decides the commit date", () => {
  it("is defined by the content-aware migration or a successor", () => {
    expect(newest >= "20260905100000_sync_apply_content_aware.sql").toBe(true);
  });

  it("keeps the existing date for an unchanged row and takes the caller's for a changed one", () => {
    expect(sql).toMatch(/when notes\.content is distinct from excluded\.content then excluded\.last_commit_at/);
    expect(sql).toMatch(/else notes\.last_commit_at/);
  });

  it("no longer lets a non-null incoming date overwrite a known one unconditionally", () => {
    expect(sql).not.toMatch(/last_commit_at = coalesce\(excluded\.last_commit_at, notes\.last_commit_at\)/);
  });

  // CREATE OR REPLACE resets every attribute the new definition omits; the advisor hardening's
  // search_path pin (20260811170000) has to be restated or it silently disappears.
  it("restates the search_path pin the hardening migration added", () => {
    expect(sql).toMatch(/set search_path = public, pg_catalog/);
  });

  it("keeps the RPC off the public, anon and authenticated roles", () => {
    expect(sql).toMatch(/revoke execute on function sync_apply\(text, text, jsonb, text\[\]\) from public, anon, authenticated/);
  });
});
