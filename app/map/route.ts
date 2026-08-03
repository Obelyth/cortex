import { TEMPLATE } from "@/lib/atlas/template";
import { demoPayload } from "@/lib/atlas/demo";

/**
 * The PUBLIC map — the same renderer as /s/<secret>/map, with nothing real on it.
 *
 * The real map is gated because it is an inventory. This one exists so the landing can show the
 * system itself: four rings, live-vs-snapshot colour semantics, the physics — populated entirely
 * by synthetic placeholders from lib/atlas/demo.ts. It fetches nothing, reads no environment,
 * and serves one byte-identical document forever, so there is nothing here to protect.
 *
 * The document is built once at module load, not per request.
 */
const PAGE = (() => {
  const safe = demoPayload()
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  // The template carries the live map's icon tables. They ship as a generic starter set, but
  // an operator is invited to extend them with their own connectors — at which point the
  // aliases become a fingerprint of the machine's roster, which is precisely what the gate
  // protects. So the demo keeps only the generic plug glyph; the named entries could never
  // render here anyway, since no demo id matches an alias. Fail loudly if the anchors drift —
  // a silently un-stripped table would put the roster on a public page.
  const plug = /"plug":\s*\{[^{}]*\}/.exec(TEMPLATE)?.[0];
  if (!plug) throw new Error("demo map: plug glyph not found in template");
  const stripped = TEMPLATE
    .replace(/const ICONS = \{[\s\S]*?\n\};/, `const ICONS = {${plug}};`)
    .replace(/ICON_ALIASES = \[[\s\S]*?\];/, "ICON_ALIASES = [];")
    // Even the comments: the template's examples cite real scope prefixes.
    .replace("(`plugin:figma:figma`, `mcp:github`)", "(`plugin:x:y`, `mcp:z`)");
  if (/github|vercel|supabase/.test(stripped.slice(stripped.indexOf("const ICONS"), stripped.indexOf("const ICONS") + 400))) {
    throw new Error("demo map: icon strip did not take");
  }

  return (
    stripped
      // Honesty first: this page must never claim to be live — including the static markup a
      // no-JS viewer or crawler sees before (or without) the boot script running.
      .replace("MEMORY LIVE", "DEMO")
      .replace('<em id="srcline">real data</em>', '<em id="srcline">synthetic data</em>')
      // The badge colour is the LIVE signal on the real map; a demo label is not live.
      .replace("color:var(--memory);max-width", "color:var(--fg-dim);max-width")
      .replace("second brain — live map", "second brain — demo")
      // The srcline suffix reads "machine rings <date>" on the real map; here everything is
      // synthetic, so the whole line says so: "N nodes · M links · data synthetic".
      .replace("machine rings ${D.stats.capturedAt}", "data ${D.stats.capturedAt}")
      .replace(" · machine rings absent", " · data synthetic")
      // The console is gated; a public page must not link it. Its slot becomes the way home.
      .replace(/<a id="consoleBtn"[^>]*>[^<]*<\/a>/, '<a id="consoleBtn" href="/">⌗ Cortex</a>')
      .replace("__DATA__", () => safe)
  );
})();

// Fully deterministic — emitted at build time, no serverless invocation per request.
export const dynamic = "force-static";

export function GET() {
  return new Response(PAGE, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Static and synthetic — a shared cache is welcome to it.
      "cache-control": "public, max-age=3600, s-maxage=86400",
      // The site is indexable, but this raw route is an embedded demo document — the
      // landing is the page that should rank, so this one opts out.
      "x-robots-tag": "noindex, nofollow",
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src 'self'",
    },
  });
}
