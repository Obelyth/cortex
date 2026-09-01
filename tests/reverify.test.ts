import { beforeEach, describe, expect, it, vi } from "vitest";
import { corpus } from "./helpers/health-corpus";

vi.mock("../lib/corpus", () => ({ loadCorpus: vi.fn() }));

import { loadCorpus } from "../lib/corpus";
import { parseFrontmatter, applyReverify } from "../lib/frontmatter";
import { health } from "../lib/health";
import { GET } from "../app/s/[secret]/console/attention/queue/route";

const mLoad = vi.mocked(loadCorpus);

beforeEach(() => vi.resetAllMocks());

/**
 * `reverify: <date>` queues a note for the groundskeeper's nightly fact-check — the operator
 * handing the check to the machine that holds the credentials, instead of doing it by hand.
 *
 * The failure direction is the OPPOSITE of `decays`, and the tests hold it there. A `decays`
 * misparse silently stops a note being checked; a `reverify` misparse merely fails to expedite
 * one check while the stale-stamp finding stays visible in the inbox. So `decays` fails toward
 * "watched" and `reverify` fails toward "not a request".
 */
describe("reverify frontmatter", () => {
  it("reads a plain date, and nothing else is a request", () => {
    expect(parseFrontmatter("---\nreverify: 2026-08-11\n---\n\nx").reverify).toBe("2026-08-11");
    expect(parseFrontmatter('---\nreverify: "2026-08-11"\n---\n\nx').reverify).toBe("2026-08-11");
    for (const v of ["tonight", "true", "2026-8-11", "2026-08-11T00:00", "", "please"]) {
      expect(parseFrontmatter(`---\nreverify: ${v}\n---\n\nx`).reverify, v).toBeUndefined();
    }
    expect(parseFrontmatter("no frontmatter").reverify).toBeUndefined();
  });

  it("ignores an indented reverify, which belongs to a nested block", () => {
    const text = '---\ndescription: "x"\nmetadata:\n  reverify: 2026-08-11\n---\n\nbody';
    expect(parseFrontmatter(text).reverify).toBeUndefined();
  });

  it("applyReverify adds the key without touching the body", () => {
    const text = '---\ndescription: "x"\ntags: [a]\n---\n\n# T\n\n_Facts last verified 2026-07-01._\n';
    const out = applyReverify(text, "2026-08-11");
    expect(parseFrontmatter(out).reverify).toBe("2026-08-11");
    // The body is what citations are proven against; a queueing function does not get to edit it.
    expect(parseFrontmatter(out).body).toBe(parseFrontmatter(text).body);
    expect(parseFrontmatter(out).description).toBe("x");
  });

  it("opens a frontmatter block when the note has none, keeping the text verbatim", () => {
    const out = applyReverify("# Bare\n\nbody\n", "2026-08-11");
    expect(parseFrontmatter(out).reverify).toBe("2026-08-11");
    expect(out.endsWith("# Bare\n\nbody\n")).toBe(true);
  });

  it("keeps the ORIGINAL request date on a second click", () => {
    // The marker records when the operator first asked; re-clicking must not quietly reset a
    // request the nightly run may already be overdue on.
    const once = applyReverify("---\ndecays: true\n---\n\nx", "2026-08-10");
    expect(applyReverify(once, "2026-08-11")).toBe(once);
  });

  it("rewrites a malformed key in place rather than adding a twin", () => {
    const broken = "---\nreverify: tonight\n---\n\nx";
    const out = applyReverify(broken, "2026-08-11");
    expect((out.match(/^reverify:/gm) ?? []).length).toBe(1);
    expect(parseFrontmatter(out).reverify).toBe("2026-08-11");
  });

  it("refuses a value that is not a plain date", () => {
    expect(() => applyReverify("x", "tonight")).toThrow();
  });
});

const STAMPED = (extra: string) =>
  `---\ndescription: "d"\n${extra}---\n\n# Page\n\n_Facts last verified 2026-07-01._\n`;

describe("the queued badge on stale-stamp findings", () => {
  const NOW = new Date("2026-08-11T12:00:00Z");

  it("threads the request through stale into the triage item", async () => {
    mLoad.mockResolvedValue(
      corpus([
        ["projects/plain.md", STAMPED("")],
        ["projects/queued.md", STAMPED("reverify: 2026-08-10\n")],
      ])
    );
    const h = await health(NOW);
    const items = h.triage.filter((t) => t.kind === "stale-stamp");
    expect(items.find((t) => t.loc === "projects/plain.md")?.queued).toBeUndefined();
    expect(items.find((t) => t.loc === "projects/queued.md")?.queued).toBe("2026-08-10");
  });

  it("a fresh request carries no alarm; one two missed runs old says so in the evidence", async () => {
    mLoad.mockResolvedValue(
      corpus([
        ["projects/fresh.md", STAMPED("reverify: 2026-08-10\n")],
        ["projects/forgotten.md", STAMPED("reverify: 2026-08-05\n")],
      ])
    );
    const h = await health(NOW);
    const fresh = h.triage.find((t) => t.loc === "projects/fresh.md");
    const forgotten = h.triage.find((t) => t.loc === "projects/forgotten.md");
    expect(fresh?.evidence).not.toContain("unconsumed");
    expect(forgotten?.evidence).toContain("unconsumed");
  });

  it("decays:false still wins — settled history cannot be queued into the clock", async () => {
    mLoad.mockResolvedValue(
      corpus([["projects/settled.md", STAMPED("decays: false\nreverify: 2026-08-10\n")]])
    );
    const h = await health(NOW);
    expect(h.stale).toEqual([]);
  });
});

describe("the groundskeeper's queue endpoint", () => {
  const ctx = (secret: string) => ({ params: Promise.resolve({ secret }) });
  const req = new Request("http://cortex.test/queue");

  it("is fail-closed: a wrong or unset secret is an empty 404", async () => {
    vi.stubEnv("CONNECTOR_PATH_SECRET", "right");
    expect((await GET(req, ctx("wrong"))).status).toBe(404);
    vi.stubEnv("CONNECTOR_PATH_SECRET", "");
    expect((await GET(req, ctx(""))).status).toBe(404);
  });

  it("splits queued from stale, queued in oldest-request-first draining order", async () => {
    vi.stubEnv("CONNECTOR_PATH_SECRET", "s3cret");
    mLoad.mockResolvedValue(
      corpus([
        // Stamps far in the past so the fixture is stale on any real clock.
        ["projects/b-later.md", "---\nreverify: 2026-08-09\n---\n\n_Facts last verified 2025-01-01._\n"],
        ["projects/a-first.md", "---\nreverify: 2026-08-05\n---\n\n_Facts last verified 2025-02-01._\n"],
        ["projects/unqueued.md", "---\ndescription: \"d\"\n---\n\n_Facts last verified 2025-03-01._\n"],
        ["notes/settled.md", "---\ndecays: false\n---\n\n_Facts last verified 2025-01-01._\n"],
      ])
    );
    const res = await GET(req, ctx("s3cret"));
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      queued: Array<{ path: string; requested: string }>;
      stale: Array<{ path: string }>;
    };
    expect(j.queued.map((q) => q.path)).toEqual(["projects/a-first.md", "projects/b-later.md"]);
    expect(j.queued[0].requested).toBe("2026-08-05");
    expect(j.stale.map((s) => s.path)).toEqual(["projects/unqueued.md"]);
  });
});
