import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/corpus", () => ({ loadCorpus: vi.fn() }));

import { loadCorpus } from "../lib/corpus";
import { buildAtlas } from "../lib/atlas";
import { GET } from "../app/s/[secret]/map/route";

const mLoad = vi.mocked(loadCorpus);
const SECRET = "a".repeat(64);

/** The machine rings as they now arrive: a sidecar riding the brain tarball, not an import. */
const SNAPSHOT = JSON.stringify({
  capturedAt: "2026-07-30",
  center: "claude",
  layers: [
    { key: "applications", label: "APPLICATIONS", color: "#aeb8c4", ring: 1 },
    { key: "routines", label: "ROUTINES", color: "#8b97a4", ring: 2 },
    { key: "skills", label: "SKILLS", color: "#677483", ring: 4 },
  ],
  nodes: [
    { id: "claude", label: "Claude", group: "core", layer: "core" },
    { id: "mcp:github", label: "github", group: "dev", layer: "applications" },
    { id: "routine:hook:x", label: "hook", group: "hook", layer: "routines" },
    { id: "skill:y", label: "skill", group: "user", layer: "skills" },
  ],
  edges: [{ source: "mcp:github", target: "projects/cortex.md", kind: "documents" }],
});

function corpus(files: Array<[string, string]>, snapshot: string | null = SNAPSHOT) {
  const map = new Map(files);
  const sidecar = new Map<string, string>();
  if (snapshot !== null) sidecar.set("tools/atlas-snapshot.json", snapshot);
  return {
    sha: "c".repeat(40),
    bytes: files.reduce((a, [, t]) => a + t.length, 0),
    files: map,
    sidecar,
  } as unknown as Awaited<ReturnType<typeof loadCorpus>>;
}

function call(secret: string) {
  const req = new Request(`https://cortex.test/s/${secret}/map`);
  return GET(req, { params: Promise.resolve({ secret }) });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CONNECTOR_PATH_SECRET", SECRET);
  mLoad.mockResolvedValue(
    corpus([
      ["log/2026-07-30.md", "# Log\n\nRan the groundskeeper.\n"],
      ["projects/cortex.md", "# cortex\n\nThe memory server.\n\nSUPERSEDED: was on Fly.\n"],
      ["profile.md", "# profile\n\nField ops and data.\n"],
    ]),
  );
});

describe("buildAtlas", () => {
  it("rebuilds the memory ring from the live corpus, one node per note", async () => {
    const { json, meta } = await buildAtlas();
    const d = JSON.parse(json);
    const memory = d.nodes.filter((n: { layer: string }) => n.layer === "memory");

    expect(memory.map((n: { id: string }) => n.id).sort()).toEqual([
      "log/2026-07-30.md",
      "profile.md",
      "projects/cortex.md",
    ]);
    expect(meta.live).toBe(3);
    // Directories become ring groups; a bare note falls back to the "note" group.
    expect(memory.find((n: { id: string }) => n.id === "log/2026-07-30.md").group).toBe("log");
    expect(memory.find((n: { id: string }) => n.id === "profile.md").group).toBe("note");
  });

  it("marks notes that carry retracted passages", async () => {
    const d = JSON.parse((await buildAtlas()).json);
    const byId = new Map(d.nodes.map((n: { id: string }) => [n.id, n]));
    expect((byId.get("projects/cortex.md") as { status?: string }).status).toBe("retracted");
    expect((byId.get("profile.md") as { status?: string }).status).toBeUndefined();
  });

  it("reads the machine layers from the sidecar, not from a committed import", async () => {
    const { json, meta } = await buildAtlas();
    const d = JSON.parse(json);
    const counts = d.stats.counts;

    expect(counts.applications).toBeGreaterThan(0);
    expect(counts.routines).toBeGreaterThan(0);
    expect(counts.skills).toBeGreaterThan(0);
    expect(d.stats.capturedAt).toBe(meta.capturedAt);
    // The live sha and the snapshot date are both on the payload so the page can label each ring.
    expect(d.stats.sha).toBe("c".repeat(12));
  });

  it("drops snapshot edges whose endpoints no longer exist in the corpus", async () => {
    const d = JSON.parse((await buildAtlas()).json);
    const ids = new Set(d.nodes.map((n: { id: string }) => n.id));
    for (const e of d.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
  });

  it("centres the map on a node that exists", async () => {
    const d = JSON.parse((await buildAtlas()).json);
    expect(d.nodes.some((n: { id: string }) => n.id === d.center)).toBe(true);
  });
});

describe("buildAtlas without a snapshot", () => {
  it("still renders the live ring, and reports the machine rings as absent", async () => {
    mLoad.mockResolvedValue(corpus([["notes/a.md", "# a\n\nBody.\n"]], null));
    const { json, meta } = await buildAtlas();
    const d = JSON.parse(json);

    expect(meta.capturedAt).toBeNull();
    expect(d.stats.capturedAt).toBeNull();
    expect(meta.snapshotted).toBe(0);
    expect(meta.live).toBe(1);
    // The live ring is defined by cortex, so it survives the snapshot going missing.
    expect(d.layers.map((l: { key: string }) => l.key)).toEqual(["memory"]);
    expect(d.nodes).toHaveLength(1);
  });

  it("refuses a malformed snapshot rather than drawing half a map", async () => {
    for (const bad of ["{", "null", "[]", JSON.stringify({ nodes: [], edges: [] })]) {
      mLoad.mockResolvedValue(corpus([["notes/a.md", "# a\n\nBody.\n"]], bad));
      const { meta } = await buildAtlas();
      expect(meta.capturedAt, `for ${bad}`).toBeNull();
    }
  });

  it("never points the renderer at a centre node it did not ship", async () => {
    const orphan = JSON.stringify({
      capturedAt: "2026-07-30", center: "ghost", layers: [], nodes: [], edges: [],
    });
    mLoad.mockResolvedValue(corpus([["notes/a.md", "# a\n\nBody.\n"]], orphan));
    const d = JSON.parse((await buildAtlas()).json);
    expect(d.center).toBe("");
  });
});

describe("buildAtlas defends the live ring", () => {
  it("drops a snapshot node that claims layer memory", async () => {
    const impostor = JSON.stringify({
      capturedAt: "2026-07-30", center: "claude",
      layers: [{ key: "applications", label: "A", color: "#aeb8c4", ring: 1 }],
      nodes: [
        { id: "claude", label: "Claude", group: "core", layer: "core" },
        { id: "fake-note", label: "fake", group: "note", layer: "memory" },
      ],
      edges: [],
    });
    mLoad.mockResolvedValue(corpus([["notes/a.md", "# a\n\nBody.\n"]], impostor));
    const { json, meta } = await buildAtlas();
    const d = JSON.parse(json);

    // The cyan ring is labelled LIVE; only the corpus may populate it.
    expect(d.nodes.filter((n: { layer: string }) => n.layer === "memory")).toHaveLength(1);
    expect(d.stats.counts.memory).toBe(meta.live);
  });

  it("drops a snapshot node that shadows a real note's path", async () => {
    const shadow = JSON.stringify({
      capturedAt: "2026-07-30", center: "claude",
      layers: [],
      nodes: [
        { id: "claude", label: "Claude", group: "core", layer: "core" },
        { id: "notes/a.md", label: "impostor", group: "x", layer: "applications" },
      ],
      edges: [],
    });
    mLoad.mockResolvedValue(corpus([["notes/a.md", "# a\n\nBody.\n"]], shadow));
    const d = JSON.parse((await buildAtlas()).json);
    const dupes = d.nodes.filter((n: { id: string }) => n.id === "notes/a.md");
    expect(dupes).toHaveLength(1);
    expect(dupes[0].layer).toBe("memory");
  });
});

describe("map route", () => {
  it("404s on wrong secret without reading the corpus, with an empty body like the MCP alias", async () => {
    const res = await call("b".repeat(64));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    expect(mLoad).not.toHaveBeenCalled();
  });

  it("locks the page down with a no-network CSP", async () => {
    const res = await call(SECRET);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("redacts a credential-shaped first line before it reaches the detail panel", async () => {
    mLoad.mockResolvedValue(
      corpus([["oops.md", "# oops\n\nADMIN_PASSWORD=hunter2 was the fix.\n"]]),
    );
    const { json } = await buildAtlas();
    expect(json).not.toContain("hunter2");
    expect(json).toContain("<redacted>");
  });

  it("escapes every < in the payload, so <!-- cannot flip the parser state", async () => {
    mLoad.mockResolvedValue(
      corpus([["evil.md", "# evil\n\nx <!-- then <script>alert(1)</script> later\n"]]),
    );
    const html = await (await call(SECRET)).text();
    const block = /<script id="data"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    expect(block).not.toBeNull();
    // No raw "<" of any kind survives inside the data block.
    expect(block![1]).not.toMatch(/<!--|<script/i);
    expect(() => JSON.parse(block![1])).not.toThrow();
  });

  it("404s when no secret is configured", async () => {
    vi.stubEnv("CONNECTOR_PATH_SECRET", "");
    expect((await call(SECRET)).status).toBe(404);
    expect(mLoad).not.toHaveBeenCalled();
  });

  it("serves a complete document with the data injected and nothing left to substitute", async () => {
    const res = await call(SECRET);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const html = await res.text();
    expect(html).not.toContain("__DATA__");
    expect(html).not.toContain("__ICONS__");
    expect(html).toContain("<canvas");
    // The glyphs must survive the port — an icon-less map is the bug we shipped once already.
    expect(html).toContain("const ICONS");

    const block = /<script id="data"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    expect(block).not.toBeNull();
    expect(() => JSON.parse(block![1])).not.toThrow();
  });

  it("never lets a note body break out of the data block", async () => {
    mLoad.mockResolvedValue(
      corpus([["evil.md", "# evil\n\nclosing </script><script>alert(1)</script> tag\n"]]),
    );
    const html = await (await call(SECRET)).text();
    const block = /<script id="data"[^>]*>([\s\S]*?)<\/script>/.exec(html);

    // The regex above stops at the FIRST </script>. If escaping worked, that is the real end of
    // the block and the captured text still parses as the whole payload.
    expect(block).not.toBeNull();
    expect(() => JSON.parse(block![1])).not.toThrow();
    expect(JSON.parse(block![1]).nodes.some((n: { id: string }) => n.id === "evil.md")).toBe(true);
  });

  it("tells caches and crawlers to keep the inventory to themselves", async () => {
    const res = await call(SECRET);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
  });
});
