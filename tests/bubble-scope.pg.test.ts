import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.CORTEX_NATIVE_PG === "1";
const socket = process.env.CORTEX_NATIVE_PG_SOCKET ?? "";
const adminConfig = { host: socket, port: 5432, user: "cortex_test", database: "postgres" };
const database = `cortex_test_bubble_${process.pid}_${Date.now()}`;
let client: Client;

// VISIBLE, not silent. A gated suite that skips itself shrinks the count and says nothing, so a
// run with no database looked identical to a run that had checked everything — for a month.
if (process.env.CORTEX_NATIVE_PG !== "1") {
  describe.skip("bubble_open_scoped native PostgreSQL contract — SKIPPED: set CORTEX_NATIVE_PG=1 and CORTEX_NATIVE_PG_SOCKET to a Unix socket directory", () => {
    it("did not run", () => {});
  });
}
describe.runIf(enabled)("bubble_open_scoped native PostgreSQL contract", () => {
  beforeAll(async () => {
    const admin = new Client(adminConfig);
    await admin.connect();
    await admin.query(`create database ${database}`);
    await admin.end();
    client = new Client({ ...adminConfig, database });
    await client.connect();
    await client.query(`
      do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
      do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
      do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;
      create table bubble_items (
        id bigint generated always as identity primary key,
        kind text not null, project text not null default '', body text not null,
        status text not null default 'open', filed_into text not null default '',
        surface text not null default '', created_at timestamptz not null default now(),
        touched_at timestamptz not null default now()
      );
    `);
    const sql = await readFile(path.resolve("supabase/migrations/20260908103956_bubble_open_scoped.sql"), "utf8");
    await client.query(sql);
  });

  afterAll(async () => {
    if (client) await client.end();
    const admin = new Client(adminConfig);
    await admin.connect();
    await admin.query(`drop database if exists ${database}`);
    await admin.end();
  });

  it("normalizes and filters before count/order/limit, with general controlled explicitly", async () => {
    const normalization = await client.query<{ normalized: string[] }>(`
      select array[
        bubble_normalize_project(E'\tprojects/Harbor.md\t'),
        bubble_normalize_project(chr(160) || 'projects/Harbor.md' || chr(160)),
        bubble_normalize_project('İ'),
        bubble_normalize_project('Σ'),
        bubble_normalize_project('ΟΣ'),
        bubble_normalize_project('K')
      ] normalized
    `);
    expect(normalization.rows[0].normalized).toEqual(["harbor", "harbor", "i̇", "σ", "ος", "k"]);

    await client.query(`
      insert into bubble_items(kind, project, body, touched_at)
      select 'focus', 'other', 'other-' || g, now() - (g || ' seconds')::interval
      from generate_series(1, 250) g;
      insert into bubble_items(kind, project, body, touched_at) values
        ('focus', ' Projects/Harbor.MD ', 'scoped-old', now() - interval '1 hour'),
        ('focus', E'\tprojects/Harbor.md\t', 'tab-padded', now() - interval '2 hours'),
        ('focus', chr(160) || 'projects/Harbor.md' || chr(160), 'nbsp-padded', now() - interval '3 hours'),
        ('focus', 'Σ', 'unicode-case', now() - interval '4 hours'),
        ('focus', '', 'general-new', now()),
        ('focus', 'harbor', 'expired', now() - interval '15 days');
    `);
    const one = await client.query<{ value: { total: number; swept: number; items: Array<{ body: string }> } }>(
      `select bubble_open_scoped(14, 1, ' projects/HARBOR.md ', true) as value`
    );
    expect(one.rows[0].value.total).toBe(4);
    expect(one.rows[0].value.swept).toBe(1);
    expect(one.rows[0].value.items.map((x) => x.body)).toEqual(["general-new"]);

    const projectOnly = await client.query<{ value: { total: number; items: Array<{ body: string }> } }>(
      `select bubble_open_scoped(14, 200, 'harbor', false) as value`
    );
    expect(projectOnly.rows[0].value.total).toBe(3);
    expect(projectOnly.rows[0].value.items.map((x) => x.body)).toEqual(["scoped-old", "tab-padded", "nbsp-padded"]);

    const unicode = await client.query<{ value: { total: number; items: Array<{ body: string }> } }>(
      `select bubble_open_scoped(14, 200, 'σ', false) as value`
    );
    expect(unicode.rows[0].value.total).toBe(1);
    expect(unicode.rows[0].value.items.map((x) => x.body)).toEqual(["unicode-case"]);

    const noGeneral = await client.query<{ value: { total: number; items: Array<{ body: string }> } }>(
      `select bubble_open_scoped(14, 200, '', false) as value`
    );
    expect(noGeneral.rows[0].value).toEqual({ total: 0, swept: 0, items: [] });
  });

  it("is executable only by service_role", async () => {
    const acl = await client.query<{ role: string; can_execute: boolean }>(`
      select role, has_function_privilege(role, 'bubble_open_scoped(integer,integer,text,boolean)', 'execute') can_execute
      from (values ('anon'), ('authenticated'), ('service_role')) roles(role)
      order by role
    `);
    expect(acl.rows).toEqual([
      { role: "anon", can_execute: false },
      { role: "authenticated", can_execute: false },
      { role: "service_role", can_execute: true },
    ]);
  });
});
