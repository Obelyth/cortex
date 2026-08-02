import { safeEqualStrings } from "@/lib/auth";
import { buildAtlas } from "@/lib/atlas";
import { TEMPLATE } from "@/lib/atlas/template";

// Reads the live corpus on every request, so it must never be cached or statically rendered.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The map sits behind the SAME path secret as the MCP alias and the console, and 404s on a
 * mismatch for the same reason: it does not advertise that anything lives here.
 *
 * It is gated because it is an inventory. Every MCP server, hook, skill and note title is on the
 * page — a map of how the operator's machine is wired is exactly what someone would want before
 * attacking it, and the note titles alone leak what they work on. The public landing page carries
 * the abstract version of this diagram; this is the one with the real names on it.
 *
 * Served as a route rather than a page because the renderer is a self-contained document. Handing
 * it back whole keeps the layout code the single source of truth for how the map looks.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ secret: string }> },
) {
  const { secret } = await params;
  const expected = process.env.CONNECTOR_PATH_SECRET;
  if (!expected || !safeEqualStrings(secret, expected)) {
    // Body matches the MCP alias's empty 404, so the two gates are not distinguishable
    // from the framework's own 404 by size alone.
    return new Response(null, { status: 404 });
  }

  const { json } = await buildAtlas();
  // The payload is injected into a <script type="application/json"> block. Escaping only
  // </script is not enough: "<!--" flips the parser into script-data-escaped state, where a
  // later "<script" swallows the real closing tag. Escaping every "<" as \u003c (legal JSON,
  // inert in HTML) closes the whole class. U+2028/9 are legal JSON and illegal in a script body.
  const safe = json
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  return new Response(TEMPLATE.replace("__DATA__", () => safe), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // An inventory of a private machine has no business in a shared cache.
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
      // The page is fully inline by construction; the CSP makes that a promise — nothing loads
      // from, or talks to, anywhere.
      "content-security-policy":
        // The display faces are served from this origin; nothing else is fetched at all.
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src 'self'",
    },
  });
}
