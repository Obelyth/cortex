import { describe, expect, it } from "vitest";
import { GET } from "../app/map/route";

/** The public demo map: the real renderer, nothing real on it. */
describe("public demo map", () => {
  it("serves without any secret, corpus, or environment", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    // Public and static — a shared cache is welcome to it.
    expect(res.headers.get("cache-control")).toContain("public");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("never claims to be live, and does not advertise the gated console", async () => {
    const html = await GET().text();
    expect(html).toContain("DEMO");
    expect(html).not.toContain("MEMORY LIVE");
    // The static markup too: a no-JS viewer or crawler must never read "real data".
    expect(html).not.toContain("real data");
    expect(html).toContain('<em id="srcline">synthetic data</em>');
    // And the srcline code path: a template drift that un-anchors the replace must fail here.
    expect(html).not.toContain("machine rings");
    expect(html).toContain("second brain — demo");
    expect(html).not.toContain('href="health"');
    // The console slot becomes the way back to the landing.
    expect(html).toContain('<a id="consoleBtn" href="/">⌗ Cortex</a>');
  });

  it("carries only synthetic nodes — every id matches the placeholder grammar", async () => {
    const html = await GET().text();
    const block = /<script id="data"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    expect(block).not.toBeNull();
    const d = JSON.parse(block![1].replace(/\\u003c/g, "<"));

    const grammar = /^(claude|connector|plugin|hook|task|skill|pack|note|project|log)(-\d{2})?$/;
    for (const n of d.nodes) expect(n.id, n.id).toMatch(grammar);
    expect(d.nodes.length).toBeGreaterThan(50);
    expect(d.stats.capturedAt).toBe("synthetic");

    // The colour semantics survive: memory is the one cyan ring, the rest are steel.
    const byKey = Object.fromEntries(d.layers.map((l: { key: string; color: string }) => [l.key, l.color]));
    expect(byKey.memory).toBe("#1fbdd6");
    expect(byKey.applications).toBe("#aeb8c4");
  });

  it("leaks nothing that looks real", async () => {
    const html = await GET().text();
    // The template's icon tables name connector services; the demo strips them, and these
    // names failing closed is what proves the strip took. ADD YOUR OWN identifiers here —
    // home directory, deployment hostname, org name, connectors you add to the icon
    // tables — so a leak fails your build too.
    for (const bad of ["/Users/", "/home/",
                       "github", "vercel", "supabase", "postgres", "playwright",
                       "ICON_ALIASES = [\n"]) {
      expect(html, bad).not.toContain(bad);
    }
  });

  it("is byte-identical across requests — there is nothing dynamic to differ", async () => {
    expect(await GET().text()).toBe(await GET().text());
  });
});
