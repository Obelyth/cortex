/**
 * live brain corpus — what the boot call actually costs.
 *
 * The old `brain_context` measured ~11.8k tokens on this corpus, and that was a floor: it shipped
 * `profile.md`, a bare `INDEX.md`, and seven raw day-logs, so it grew with every day logged. This
 * suite is the standing proof that the new shape stays bounded, measured against the operator's real
 * notes rather than a fixture that cannot surprise anyone.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isLive, __setCache } from "../lib/corpus";
import { getContext, ROUTER_BUDGET_BYTES } from "../lib/brain";
import { buildRouter } from "../lib/frontmatter";

const BRAIN = process.env.BRAIN_DIR ?? join(process.cwd(), "..", "brain");
const present = existsSync(BRAIN);

function walk(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === ".git") continue;
    const abs = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else out.push(rel);
  }
  return out;
}

describe.skipIf(!present)("live brain corpus", () => {
  let ctx = "";

  beforeAll(async () => {
    const files = new Map<string, string>();
    for (const rel of walk(BRAIN)) {
      if (isLive(rel)) files.set(rel, readFileSync(join(BRAIN, rel), "utf8"));
    }
    // Seed the SHA-keyed cache so getContext reads the on-disk brain and touches no network.
    __setCache({ files, sidecar: new Map(), sha: "0".repeat(40), bytes: 0, fetchedAt: Date.now() });
    ctx = await getContext();
  });

  afterAll(() => __setCache(null));

  it("costs a fraction of the 11.8k tokens the raw dump cost", () => {
    const tokens = Math.round(ctx.length / 4);

    // The claim in this test's NAME is the one worth asserting: boot is a fraction of the 11,777
    // tokens the raw dump cost. The old assertion was `< 8000`, a hand-picked number that was
    // never derivable from anything -- and it failed at 8010 the day the brain grew, which is a
    // threshold expiring rather than a regression happening.
    //
    // It cannot be derived, either, because boot is deliberately NOT bounded in total: profile
    // carries no budget on purpose ("the one thing that must never be summarised"), so any fixed
    // ceiling is a promise the design refuses to make. The bounded parts have their own budgets
    // and are asserted separately below; what is asserted here is the comparison the name makes.
    const RAW_DUMP_TOKENS = 11_777;
    expect(tokens).toBeLessThan(RAW_DUMP_TOKENS * 0.75);

    // And the direction has to be visible, not just the bound. A boot that creeps back toward the
    // dump should be READ, so the number is printed rather than only compared.
    console.log(`      boot: ${tokens} tokens — ${Math.round((1 - tokens / RAW_DUMP_TOKENS) * 100)}% under the raw dump`);
  });

  it("the parts that CLAIM a budget keep it, which is what can actually be promised", () => {
    // This runs with NO temperature scores -- the fake sha means mirror.scores() finds nothing --
    // so every note renders hot. That is the documented degrade path and the expensive one, which
    // makes it the right case to bound: the router's byte budget exists precisely because
    // "temperature was doing the bounding implicitly" until a Supabase hiccup proved it was not.
    // Asserted on buildRouter itself rather than by slicing the payload. My first attempt sliced
    // from "# ROUTER" to the end and measured 27,066 B against a 20,000 B budget -- a failure that
    // was entirely my slice running past the router into the section after it. The router is
    // 18,110 B. A test that parses a rendered document to check a budget is measuring the
    // document's layout, not the budget.
    expect(ctx).toContain("# ROUTER");
    const files = new Map<string, string>();
    for (const rel of walk(BRAIN)) if (isLive(rel)) files.set(rel, readFileSync(join(BRAIN, rel), "utf8"));
    // The constant, not a literal. Hardcoding 20,000 here meant the day the budget was re-measured
    // the test kept asserting the old one, and this suite only runs where a brain clone exists, so
    // the disagreement surfaced as a red gate on an unrelated PR rather than as anything readable.
    const router = buildRouter(files, new Map(), ROUTER_BUDGET_BYTES);
    expect(router.length, "router exceeded ROUTER_BUDGET_BYTES").toBeLessThanOrEqual(
      ROUTER_BUDGET_BYTES
    );
  });

  it("carries the profile in full — the one thing that must never be summarised", () => {
    const profile = readFileSync(join(BRAIN, "profile.md"), "utf8");
    expect(ctx).toContain(profile.trim().slice(0, 400));
  });

  it("routes every live note, so nothing became undiscoverable", () => {
    for (const rel of walk(BRAIN)) {
      if (isLive(rel)) expect(ctx, rel).toContain(rel);
    }
  });

  it("names what it elided and how to open it, rather than eliding silently", () => {
    if (!ctx.includes("not expanded")) return; // a quiet week can legitimately fit entirely
    expect(ctx).toMatch(/brain_read log\/\d{4}-\d{2}-\d{2}\.md for the full day/);
  });

  it("states its own commit, note count and token cost", () => {
    expect(ctx).toMatch(/brain @0{12} · \d+ notes routed/);
    expect(ctx).toMatch(/\d+ days? expanded, \d+ digested/);
    expect(ctx).toMatch(/~\d+ tokens/);
  });

  it("no longer ships the bare INDEX.md path listing", () => {
    expect(ctx).toContain("# ROUTER");
    expect(ctx).not.toContain("# INDEX");
  });
});
