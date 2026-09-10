import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const sql = readFileSync("supabase/migrations/20260902120000_ops_ledger.sql", "utf8");

describe("ops ledger migration", () => {
  it.each(["ops_units", "ops_runs", "ops_events"])("creates %s with RLS enabled", (t) => {
    expect(sql).toMatch(new RegExp(`create table if not exists ${t}\\b`));
    expect(sql).toMatch(new RegExp(`alter table ${t} enable row level security`));
  });
  it("ships no installation-specific Ops units", () => {
    expect(sql).not.toMatch(/\binsert into\s+(?:public\.)?ops_units\b/i);
  });
  it("uses the installation-neutral operator actor", () => {
    expect(sql).toMatch(/actor in \('unit','sweep','operator','guest'\)/);
  });
});

describe("run-now links migration", () => {
  const links = readFileSync("supabase/migrations/20260902130000_run_now_links.sql", "utf8");
  it("does not install private routine links", () => {
    expect(links).not.toMatch(/\bupdate\s+(?:public\.)?ops_units\b/i);
    expect(links).not.toContain("claude.ai/code/routines/");
  });
});

describe("agent units migration", () => {
  const path = "supabase/migrations/20260902140000_agent_units.sql";
  const sql = readFileSync(path, "utf8");
  it("does not install a developer workstation agent", () => {
    expect(sql).not.toMatch(/\binsert into\s+(?:public\.)?ops_units\b/i);
  });
});

describe("neutral installation migration",()=>{
  const sql=readFileSync("supabase/migrations/20260909032839_neutral_console_installation.sql","utf8");
  it("extends the neutral actor set for console receipts",()=>{
    expect(sql).toMatch(/actor in \('unit','sweep','operator','guest','console'\)/);
  });
});
