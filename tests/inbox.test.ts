import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  supersededNotes,
  supersededLinkItems,
  coaccessGapItems,
  correctionChainItems,
  watchItems,
  wasSpans,
  COACCESS_FLOOR,
  COACCESS_TOP_K,
} from "../lib/inbox";
import type { EdgeRow } from "../lib/edges";

/** A corpus in a line — the edges.test.ts idiom. */
const corpus = (entries: Record<string, string>) => new Map(Object.entries(entries));

/** The house way to retire a whole note: its description LEADS with the word. */
const DEAD = `---\ndescription: "SUPERSEDED — retired at the cutover; kept for the why"\n---\n\n# Old harbor plan\n\nEverything here is history.\n`;

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("supersededNotes — what counts as a retired page", () => {
  it("a description LEADING with SUPERSEDED marks the note; a mid-sentence mention does not", () => {
    const files = corpus({
      "notes/dead.md": DEAD,
      // competitive-landscape.md's live shape: prose ABOUT the stamp vocabulary, not a retired page.
      "notes/about-stamps.md": `---\ndescription: "How answers get stamped VERIFIED or SUPERSEDED against a commit"\n---\n\nprose\n`,
      "notes/plain.md": "# No frontmatter at all\n",
    });
    expect([...supersededNotes(files)]).toEqual(["notes/dead.md"]);
  });
});

describe("check 1 — live link to a superseded note", () => {
  it("fires on a [[wiki-link]], with the linking line and the target's marker as evidence", () => {
    const files = corpus({
      "notes/dead.md": DEAD,
      "projects/harbor.md": "# Harbor\n\nThe mooring rules live in [[dead]] and still apply.\n",
    });
    const items = supersededLinkItems(files);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sev: "watch", kind: "superseded-link", loc: "projects/harbor.md:3" });
    expect(items[0].evidence).toContain("L3:");
    expect(items[0].evidence).toContain("The mooring rules live in");
    expect(items[0].evidence).toContain("notes/dead.md");
    expect(items[0].evidence).toContain("SUPERSEDED");
  });

  it("fires on a bare path reference, and one item covers repeat references to the same target", () => {
    const files = corpus({
      "notes/dead.md": DEAD,
      "projects/harbor.md":
        "# Harbor\n\nSee notes/dead.md for the mooring rules.\n\nAnd notes/dead.md again for the tides.\n",
    });
    const items = supersededLinkItems(files);
    expect(items).toHaveLength(1);
    expect(items[0].loc).toBe("projects/harbor.md:3");
    expect(items[0].evidence).toContain("+1 more");
  });

  it("a full-path [[wiki-link]] counts once, not twice against the bare-path scan", () => {
    const files = corpus({
      "notes/dead.md": DEAD,
      // The path is written as the wiki-link's own inner text — resolveRef catches it, and the
      // literal path inside the brackets must not be re-counted by the bare-path pass.
      "projects/harbor.md": "# Harbor\n\nThe rules live in [[notes/dead.md]] still.\n",
    });
    const items = supersededLinkItems(files);
    expect(items).toHaveLength(1);
    expect(items[0].loc).toBe("projects/harbor.md:3");
    // One physical reference — the evidence must not invent a phantom second mention.
    expect(items[0].evidence).not.toContain("more");
  });

  it("reports the FIRST reference by POSITION when a bare path precedes a [[link]] in one block", () => {
    const files = corpus({
      "notes/dead.md": DEAD,
      // Two consecutive non-blank lines merge into one block; the bare path is on line 3, the
      // [[link]] on line 4. The item must point at line 3, not at whichever kind was scanned first.
      "projects/harbor.md":
        "# Harbor\n\nThe rules are in notes/dead.md and\nthey were also captured as [[dead]] earlier.\n",
    });
    const items = supersededLinkItems(files);
    expect(items).toHaveLength(1);
    expect(items[0].loc).toBe("projects/harbor.md:3");
    expect(items[0].evidence).toContain("L3: The rules are in notes/dead.md and");
    // Two genuinely distinct references — a bare path and a link — so the count IS honest here.
    expect(items[0].evidence).toContain("+1 more");
  });

  it("a LONGER path containing the superseded one is a different note, not a reference", () => {
    const files = corpus({
      "notes/dead.md": DEAD,
      // archive/ is not even loadable as live corpus, but prose can still NAME such a path.
      "projects/harbor.md": "# Harbor\n\nThe old copy sits at archive/notes/dead.md for history.\n",
    });
    expect(supersededLinkItems(files)).toHaveLength(0);
  });

  it("PRECISION PIN — a reference inside a quoted (was: \"…\") parenthetical never fires", () => {
    const files = corpus({
      "notes/dead.md": DEAD,
      "projects/harbor.md":
        '# Harbor\n\nMooring is governed by the port authority (was: "self-managed per notes/dead.md").\n',
    });
    expect(supersededLinkItems(files)).toHaveLength(0);
  });

  it("PRECISION PIN — the LOOSE unquoted (was: …) form is excluded too — the live design-brand-note shape", () => {
    const files = corpus({
      "notes/dead.md": DEAD,
      // Replica of the live shape: the note explaining what it USED to say, with the pointer
      // to the retired page inside the parenthetical.
      "projects/harbor.md":
        "# Harbor\n\n- **Anchor** — uses this brand. (was: this page used to cover the old plan instead — updated 2026-07-24; see notes/dead.md.)\n",
    });
    expect(supersededLinkItems(files)).toHaveLength(0);
  });

  it("a reference OUTSIDE the (was:) span in the same block still fires", () => {
    const files = corpus({
      "notes/dead.md": DEAD,
      "projects/harbor.md":
        '# Harbor\n\nRules live in notes/dead.md today (was: "they were unwritten").\n',
    });
    expect(supersededLinkItems(files)).toHaveLength(1);
  });

  it("a reference in a retracted block — its own banner or a neighbouring one — never fires", () => {
    const files = corpus({
      "notes/dead.md": DEAD,
      "projects/own.md":
        "# Own\n\n**SUPERSEDED 2026-08-01 — see the new page.** The plan follows notes/dead.md.\n",
      "projects/neighbour.md":
        "# Neighbour\n\n> **SUPERSEDED 2026-08-01 — history below.**\n\nThe plan follows notes/dead.md.\n",
    });
    expect(supersededLinkItems(files)).toHaveLength(0);
  });

  it("a dated log entry and a dated heading are records, not live claims", () => {
    const files = corpus({
      "notes/dead.md": DEAD,
      "log/2026-08-09.md": "# 2026-08-09\n\nClosed the open item on notes/dead.md tonight.\n",
      "projects/harbor.md":
        "# Harbor\n\n## Cleanup found on the box 2026-07-31\n\nDeleted the scripts notes/dead.md described.\n",
    });
    expect(supersededLinkItems(files)).toHaveLength(0);
  });

  it("a superseded note referencing another superseded note is history pointing at history", () => {
    const files = corpus({
      "notes/dead.md": DEAD,
      "notes/also-dead.md": `---\ndescription: "SUPERSEDED — folded into the new page"\n---\n\nGrew out of [[dead]].\n`,
    });
    expect(supersededLinkItems(files)).toHaveLength(0);
  });

  it("an ambiguous [[ref]] resolves to nothing and cannot fire", () => {
    const files = corpus({
      "notes/setup.md": DEAD,
      "projects/setup.md": DEAD,
      "projects/harbor.md": "# Harbor\n\nSee [[setup]] for the rules.\n",
    });
    expect(supersededLinkItems(files)).toHaveLength(0);
  });

  it("LEAVES when the reference goes, and when the target un-supersedes", () => {
    const linked = "# Harbor\n\nThe rules live in [[dead]] still.\n";
    expect(supersededLinkItems(corpus({ "notes/dead.md": DEAD, "projects/harbor.md": linked }))).toHaveLength(1);
    // The link is removed — the item derives from the corpus, so it is simply gone.
    expect(
      supersededLinkItems(corpus({ "notes/dead.md": DEAD, "projects/harbor.md": "# Harbor\n\nRules moved.\n" }))
    ).toHaveLength(0);
    // The target's description stops claiming SUPERSEDED — same mechanics from the other end.
    const revived = `---\ndescription: "The live harbor plan"\n---\n\n# Harbor plan\n`;
    expect(
      supersededLinkItems(corpus({ "notes/dead.md": revived, "projects/harbor.md": linked }))
    ).toHaveLength(0);
  });
});

describe("wasSpans — the parenthetical finder", () => {
  it("finds quoted and loose spans, honouring nested parens", () => {
    const text = 'now (was: "old (very old) thing") and (was: loose form here) end';
    const spans = wasSpans(text);
    expect(spans).toHaveLength(2);
    const cut = (s: [number, number]) => text.slice(s[0], s[1]);
    expect(cut(spans[0])).toBe('(was: "old (very old) thing")');
    expect(cut(spans[1])).toBe("(was: loose form here)");
  });

  it("an unclosed parenthetical runs to the end of the block — exclusion is the safe direction", () => {
    const text = "now (was: never closed, references notes/dead.md";
    expect(wasSpans(text)).toEqual([[4, text.length]]);
  });
});

describe("check 2 — co-read pair with no link", () => {
  const co = (src: string, dst: string, weight: number): EdgeRow => ({
    src,
    dst,
    kind: "coaccess",
    weight,
    evidence: `co-read in ${weight} shared one-hour windows of note_access`,
  });
  // Deliberately distinctive names: the mention filter matches a note's filename base in prose,
  // so a test note called a.md would be "named" by every article in every body.
  const unlinked = corpus({
    "projects/kiln.md": "# Firing\n\nCone schedule.\n",
    "notes/glaze.md": "# Recipes\n\nOxide ratios.\n",
  });

  it("fires at the floor, carrying the co-access evidence and the leave conditions", () => {
    const items = coaccessGapItems(unlinked, [co("notes/glaze.md", "projects/kiln.md", COACCESS_FLOOR)]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sev: "watch", kind: "coaccess-gap", loc: "notes/glaze.md ↔ projects/kiln.md" });
    expect(items[0].evidence).toContain(`${COACCESS_FLOOR} shared one-hour windows`);
    expect(items[0].action).toContain("[[link]]");
    // The copy claims mutual prominence and the top-K leave condition — what is now true.
    expect(items[0].action).toContain(`top-${COACCESS_TOP_K}`);
  });

  it("below the floor is silence — the floor is the whole point", () => {
    expect(coaccessGapItems(unlinked, [co("notes/glaze.md", "projects/kiln.md", COACCESS_FLOOR - 1)])).toHaveLength(0);
  });

  it("the floor is a parameter — the console knob raises it and the same pair goes quiet", () => {
    const edge = [co("notes/glaze.md", "projects/kiln.md", COACCESS_FLOOR)];
    expect(coaccessGapItems(unlinked, edge, COACCESS_FLOOR + 1)).toHaveLength(0);
    const kept = coaccessGapItems(unlinked, edge, COACCESS_FLOOR);
    expect(kept).toHaveLength(1);
    // The leave conditions state the floor that actually applied, not the default.
    expect(coaccessGapItems(unlinked, [co("notes/glaze.md", "projects/kiln.md", 9)], 8)[0].action).toContain(
      "below 8 shared windows"
    );
  });

  it("LEAVES when either note names the other — [[wiki-link]] or bare path, either direction", () => {
    const edge = [co("notes/glaze.md", "projects/kiln.md", 9)];
    const wiki = corpus({
      "projects/kiln.md": "# Firing\n\nPairings live in [[glaze]].\n",
      "notes/glaze.md": "# Recipes\n\nOxide ratios.\n",
    });
    const bare = corpus({
      "projects/kiln.md": "# Firing\n\nCone schedule.\n",
      "notes/glaze.md": "# Recipes\n\nSee projects/kiln.md for firings.\n",
    });
    expect(coaccessGapItems(wiki, edge)).toHaveLength(0);
    expect(coaccessGapItems(bare, edge)).toHaveLength(0);
  });

  it("an endpoint the corpus no longer holds produces nothing — access history outlives deletions", () => {
    expect(coaccessGapItems(unlinked, [co("notes/gone.md", "projects/kiln.md", 9)])).toHaveLength(0);
  });

  it("ignores rows of any other kind, whatever the caller fetched", () => {
    const rows: EdgeRow[] = [{ src: "notes/glaze.md", dst: "projects/kiln.md", kind: "lexical", weight: 99, evidence: "x" }];
    expect(coaccessGapItems(unlinked, rows)).toHaveLength(0);
  });

  describe("filter 1 — diary endpoints are outside the check's universe", () => {
    it("a day-log endpoint never surfaces, whatever the weight — a dated record needs no forward links", () => {
      const files = corpus({
        "log/2026-08-09.md": "# 2026-08-09\n\nRead everything tonight.\n",
        "projects/kiln.md": "# Firing\n\nCone schedule.\n",
      });
      expect(coaccessGapItems(files, [co("log/2026-08-09.md", "projects/kiln.md", 9)])).toHaveLength(0);
    });

    it("profile.md never surfaces — the boot file rides every seat, so a link adds no discoverability", () => {
      const files = corpus({
        "profile.md": "# Profile\n\nThe operator.\n",
        "projects/kiln.md": "# Firing\n\nCone schedule.\n",
      });
      expect(coaccessGapItems(files, [co("profile.md", "projects/kiln.md", 9)])).toHaveLength(0);
    });

    it("diary edges do not crowd the rankings either — a bulk absorb run cannot push a real pair out of the top-K", () => {
      // kiln's three heaviest co-reads are day-logs (the groundskeeper's signature). If those
      // edges ranked, glaze would sit at rank 4 and the one real pair here would be suppressed.
      const files = corpus({
        "log/2026-08-07.md": "# 2026-08-07\n\nAbsorbed.\n",
        "log/2026-08-08.md": "# 2026-08-08\n\nAbsorbed.\n",
        "log/2026-08-09.md": "# 2026-08-09\n\nAbsorbed.\n",
        "projects/kiln.md": "# Firing\n\nCone schedule.\n",
        "notes/glaze.md": "# Recipes\n\nOxide ratios.\n",
      });
      const rows = [
        co("log/2026-08-07.md", "projects/kiln.md", 9),
        co("log/2026-08-08.md", "projects/kiln.md", 8),
        co("log/2026-08-09.md", "projects/kiln.md", 7),
        co("notes/glaze.md", "projects/kiln.md", COACCESS_FLOOR),
      ];
      const items = coaccessGapItems(files, rows);
      expect(items.map((i) => i.loc)).toEqual(["notes/glaze.md ↔ projects/kiln.md"]);
    });
  });

  describe("filter 2 — a live prose mention counts as naming", () => {
    const edge = [co("notes/glaze.md", "projects/kiln.md", 9)];

    it("the filename base in prose suppresses the pair, case-insensitively — the trail exists without brackets", () => {
      const base = corpus({
        "projects/kiln.md": "# Firing\n\nCone schedule.\n",
        "notes/glaze.md": "# Recipes\n\nMatch cones to the kiln before firing.\n",
      });
      const cased = corpus({
        "projects/kiln.md": "# Firing\n\nCone schedule.\n",
        "notes/glaze.md": "# Recipes\n\nThe Kiln decides the cone.\n",
      });
      expect(coaccessGapItems(base, edge)).toHaveLength(0);
      expect(coaccessGapItems(cased, edge)).toHaveLength(0);
    });

    it("the slug form (path minus .md) suppresses too", () => {
      const files = corpus({
        "projects/kiln.md": "# Firing\n\nCone schedule.\n",
        "notes/glaze.md": "# Recipes\n\nFirings are tracked under projects/kiln these days.\n",
      });
      expect(coaccessGapItems(files, edge)).toHaveLength(0);
    });

    it("the frontmatter name: suppresses — a note is known by the name it declares", () => {
      const files = corpus({
        "projects/kiln.md": "---\nname: reduction-kiln\n---\n\n# Firing\n\nCone schedule.\n",
        "notes/glaze.md": "# Recipes\n\nCones for the reduction-kiln run hotter.\n",
      });
      expect(coaccessGapItems(files, edge)).toHaveLength(0);
    });

    it("a name inside a longer hyphenated token is a different identifier, not a mention", () => {
      const files = corpus({
        "projects/kiln.md": "# Firing\n\nCone schedule.\n",
        "notes/glaze.md": "# Recipes\n\nThe kiln-v2 rebuild changed nothing here.\n",
      });
      expect(coaccessGapItems(files, edge)).toHaveLength(1);
    });

    it("a mention inside a (was: …) parenthetical is the note explaining its past — the pair still fires", () => {
      const files = corpus({
        "projects/kiln.md": "# Firing\n\nCone schedule.\n",
        "notes/glaze.md": '# Recipes\n\nCones are set by eye (was: "matched to the kiln").\n',
      });
      expect(coaccessGapItems(files, edge)).toHaveLength(1);
    });

    it("a mention inside a banner-retracted block is history, not a trail — the pair still fires", () => {
      const files = corpus({
        "projects/kiln.md": "# Firing\n\nCone schedule.\n",
        "notes/glaze.md":
          "# Recipes\n\n**SUPERSEDED 2026-08-01 — see the new page.** Old rules matched the kiln.\n",
      });
      expect(coaccessGapItems(files, edge)).toHaveLength(1);
    });
  });

  describe("filter 3 — mutual top-K, the hub gate", () => {
    // The measured live shape (2026-08-11): one hub with dozens of co-access partners, and every
    // floor-passing pair through it. The hub sits at the top of everyone's list; almost nobody
    // sits at the top of the hub's.
    const files = corpus({
      "projects/studio.md": "# Overview\n\nEverything passes through here.\n",
      "notes/kiln.md": "# Firing\n\nCone schedule.\n",
      "notes/glaze.md": "# Recipes\n\nOxide ratios.\n",
      "notes/wheel.md": "# Throwing\n\nCentering drills.\n",
      "notes/ash.md": "# Slip\n\nSieving guide.\n",
    });
    const rows = [
      co("notes/kiln.md", "projects/studio.md", 9),
      co("notes/glaze.md", "projects/studio.md", 8),
      co("notes/wheel.md", "projects/studio.md", 7),
      co("notes/ash.md", "projects/studio.md", 6),
      co("notes/ash.md", "notes/kiln.md", 6),
    ];

    it("a hub pair is suppressed when the hub does not rank the partner back, even well above the floor", () => {
      const locs = coaccessGapItems(files, rows).map((i) => i.loc);
      // ash clears the floor comfortably (6 > 5) and studio is ash's heaviest partner — but ash
      // is rank 4 of 4 for studio, so the prominence is one-sided and the pair stays silent.
      expect(locs).not.toContain("notes/ash.md ↔ projects/studio.md");
      // The same weight between two ordinary notes IS mutually prominent, and fires: the gate
      // measures specificity, not weight.
      expect(locs).toContain("notes/ash.md ↔ notes/kiln.md");
      // Pairs the hub ranks back are genuinely mutual — the gate suppresses hub NOISE, not hubs.
      expect(locs).toEqual([
        "notes/ash.md ↔ notes/kiln.md",
        "notes/glaze.md ↔ projects/studio.md",
        "notes/kiln.md ↔ projects/studio.md",
        "notes/wheel.md ↔ projects/studio.md",
      ]);
    });

    it("the floor still gates candidacy first — a mutually-top-1 pair below it stays silent", () => {
      const pair = [co("notes/ash.md", "notes/kiln.md", COACCESS_FLOOR)];
      expect(coaccessGapItems(files, pair, COACCESS_FLOOR + 1)).toHaveLength(0);
      expect(coaccessGapItems(files, pair, COACCESS_FLOOR)).toHaveLength(1);
    });
  });
});

describe("check 3 — correction chain crossing notes", () => {
  // The live shape that gated this check: each page's correcting block names the other.
  const mutual = corpus({
    "projects/alpha.md":
      "# Alpha\n\n**CORRECTION 2026-08-01:** the port in notes/beta.md was wrong; it is 9443.\n",
    "notes/beta.md":
      '# Beta\n\nThe port is 8443 (was: "9443, corrected in projects/alpha.md — later re-measured").\n',
  });

  it("fires ONCE per mutual pair, with both line references as evidence", () => {
    const items = correctionChainItems(mutual);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sev: "watch", kind: "correction-chain", loc: "notes/beta.md ↔ projects/alpha.md" });
    // Both sides, each with its own line reference — the check's contract.
    expect(items[0].evidence).toContain("notes/beta.md L3:");
    expect(items[0].evidence).toContain("projects/alpha.md L3:");
  });

  it("a one-directional correction is not a chain — the loose shape fired 14 times on the live corpus, 13 of them noise", () => {
    const oneWay = corpus({
      "projects/alpha.md":
        "# Alpha\n\n**CORRECTION 2026-08-01:** the port in notes/beta.md was wrong; it is 9443.\n",
      "notes/beta.md": "# Beta\n\nThe port is 9443.\n",
    });
    expect(correctionChainItems(oneWay)).toHaveLength(0);
  });

  it("a day-log endpoint is out — the diary doctrine checks 1 and 2 already apply", () => {
    // A mutual chain exists in the raw edges: the log's **CORRECTION** names the page, and the
    // page's (was: …) names the log back. But a day-log is a dated record, not a live claim, and
    // 'log/' sorts first so it would be the pair's canonical path — the only end the console's
    // one "settled" button targets, which the verify route refuses (nothing on a diary to settle).
    // Check 3 drops the dated endpoint like checks 1 and 2, so no un-actionable item surfaces.
    const withLog = corpus({
      "log/2026-08-01.md":
        "# 2026-08-01\n\n**CORRECTION 2026-08-05:** the port in projects/alpha.md was wrong.\n",
      "projects/alpha.md":
        '# Alpha\n\nPort is 8443 (was: "9443 per log/2026-08-01.md, re-measured").\n',
    });
    expect(correctionChainItems(withLog)).toHaveLength(0);
  });

  it("LEAVES when the chain is collapsed — one side stops correcting the other", () => {
    const collapsed = corpus({
      "projects/alpha.md":
        "# Alpha\n\n**CORRECTION 2026-08-01:** the port in notes/beta.md was wrong; it is 9443.\n",
      // beta absorbed the story; its text no longer carries a correction naming alpha.
      "notes/beta.md": "# Beta\n\nThe port is 8443, re-measured 2026-08-05.\n",
    });
    expect(correctionChainItems(collapsed)).toHaveLength(0);
  });
});

/**
 * `decays: false` — the one opt-out, and the only honest answer this console could offer for a
 * finding whose real fix is an edit it cannot make.
 *
 * It already meant "this note records something that happened rather than something true now",
 * and already excused a note from the stale-stamp clock. It now excuses it from these three too,
 * because the same reasoning covers them: a retired project page does not need its dead links
 * repointed or its co-read pairs written down. Live 2026-08-17, three projects were retired in
 * one evening and their pages kept generating watch items about work nobody will ever do.
 *
 * It is still not a dismiss — it is a claim written into the note, as a commit, that any reader
 * can see and disagree with.
 */
describe("settled notes leave the watch checks", () => {
  const SETTLED = (body: string) =>
    `---\ndecays: false\ndescription: "A record of something finished"\n---\n\n${body}`;

  it("a settled note stops generating superseded-link items", async () => {
    const live = corpus({
      "notes/dead.md": DEAD,
      "projects/harbor.md": "# Harbor\n\nThe rules live in [[dead]] still.\n",
    });
    expect((await watchItems({ files: live })).map((i) => i.kind)).toEqual(["superseded-link"]);

    const settled = corpus({
      "notes/dead.md": DEAD,
      "projects/harbor.md": SETTLED("# Harbor\n\nThe rules live in [[dead]] still.\n"),
    });
    expect(await watchItems({ files: settled })).toHaveLength(0);
  });

  it("EITHER side of a pair settles it — the ask is moot once one end is finished", async () => {
    const chain = {
      "projects/alpha.md": "# Alpha\n\n**CORRECTION 2026-08-01:** the port in notes/beta.md was wrong.\n",
      "notes/beta.md": '# Beta\n\nPort is 8443 (was: "9443 per projects/alpha.md, re-measured").\n',
    };
    expect((await watchItems({ files: corpus(chain) })).map((i) => i.kind)).toEqual([
      "correction-chain",
    ]);

    // The first of the pair…
    expect(
      await watchItems({ files: corpus({ ...chain, "projects/alpha.md": SETTLED(chain["projects/alpha.md"]) }) })
    ).toHaveLength(0);
    // …and the second, which is the half a naive `loc.startsWith` filter would have missed.
    expect(
      await watchItems({ files: corpus({ ...chain, "notes/beta.md": SETTLED(chain["notes/beta.md"]) }) })
    ).toHaveLength(0);
  });

  it("BUG GUARD: only an explicit false settles a note — the parse fails toward watched", async () => {
    // Same direction of failure decays is parsed with. A typo must not silently empty the queue.
    for (const v of ["maybe", "flase", "true", "0", ""]) {
      const files = corpus({
        "notes/dead.md": DEAD,
        "projects/harbor.md": `---\ndecays: ${v}\n---\n\n# Harbor\n\nThe rules live in [[dead]] still.\n`,
      });
      expect((await watchItems({ files })).length, v).toBe(1);
    }
  });
});

describe("watchItems — the assembler and the absent-edges fallback", () => {
  // A corpus where check 1 and check 3 each have one honest item.
  const files = corpus({
    "notes/dead.md": DEAD,
    "projects/harbor.md": "# Harbor\n\nThe rules live in [[dead]] still.\n",
    "projects/alpha.md": "# Alpha\n\n**CORRECTION 2026-08-01:** the port in notes/beta.md was wrong.\n",
    "notes/beta.md": '# Beta\n\nPort is 8443 (was: "9443 per projects/alpha.md, re-measured").\n',
  });

  it("with the store OFF the pure-corpus checks run, the co-read check is silently absent, and no fetch happens", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const items = await watchItems({ files });
    expect(items.map((i) => i.kind)).toEqual(["superseded-link", "correction-chain"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("with the table missing (404) the co-read check stays absent rather than inventing an answer", async () => {
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ code: "PGRST205" }, 404)));
    const items = await watchItems({ files });
    expect(items.map((i) => i.kind)).toEqual(["superseded-link", "correction-chain"]);
  });

  it("with the store UNWELL (fetch throws) the pure checks still answer", async () => {
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("store down"))));
    const items = await watchItems({ files });
    expect(items.map((i) => i.kind)).toEqual(["superseded-link", "correction-chain"]);
  });

  it("with the store answering, all three checks ride the queue in spec order", async () => {
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "k");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRes([
          { src: "notes/beta.md", dst: "projects/harbor.md", kind: "coaccess", weight: 7, evidence: "co-read in 7 shared one-hour windows" },
        ])
      )
    );
    const items = await watchItems({ files });
    expect(items.map((i) => i.kind)).toEqual(["superseded-link", "coaccess-gap", "correction-chain"]);
    expect(items.every((i) => i.sev === "watch")).toBe(true);
  });
});
