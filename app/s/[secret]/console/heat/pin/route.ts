import { gateConsolePost, bad } from "../../post-gate";
import { pinStore } from "@/lib/pins";

/**
 * The pin endpoint — the console's second write, and the heat view's only mutation.
 *
 * Same posture as settings/save: a route handler under the secret path (never a server action,
 * whose id ships in a public chunk), gated by post-gate's prove-the-secret / refuse-cross-origin
 * / demand-JSON, wrong secret answered with the same empty 404 as every other gate.
 *
 * A pin is an operator judgement recorded in note_pins and nothing else: no note changes, no
 * commit happens, and unpinning restores the computed temperature exactly. That reversibility is
 * why this write gets to exist on a console that otherwise only reads.
 */
export const dynamic = "force-dynamic";

/** What note_pins may name: the mirror's own write-policy shape. Not READ_PATH_RE — archive/
 *  is never mirrored, so a pin there would be a row about a note the scorer cannot see. */
const PIN_PATH_RE = /^(profile\.md|(projects|notes|log)\/[A-Za-z0-9._-]+\.md)$/;

const TEMPS = new Set(["hot", "warm", "cold"]);

export async function POST(
  req: Request,
  ctx: { params: Promise<{ secret: string }> }
): Promise<Response> {
  const gate = await gateConsolePost(req, ctx.params);
  if ("deny" in gate) return gate.deny;
  const b = gate.body;

  const path = b.path;
  if (typeof path !== "string" || !PIN_PATH_RE.test(path) || path.includes("..")) {
    return bad("path must be a live note path: profile.md, projects/*.md, notes/*.md or log/*.md");
  }

  const store = pinStore();
  if (!store) {
    // Named consequence, not a shrug: without the store there is no note_pins to write.
    return bad("pins need the mirror store — SUPABASE_URL is unset on this deploy, so note_pins does not exist", 503);
  }

  // `pin: null` clears; `pin: { temperature, reason? }` places or moves.
  if (!("pin" in b)) return bad("body must carry `pin`: null to unpin, or { temperature, reason? }");
  const pin = b.pin;

  try {
    if (pin === null) {
      await store.clear(path);
      return Response.json({ ok: true, path, pin: null });
    }
    if (typeof pin !== "object" || Array.isArray(pin)) {
      return bad("pin must be null or an object { temperature, reason? }");
    }
    const p = pin as Record<string, unknown>;
    const temperature = p.temperature;
    if (typeof temperature !== "string" || !TEMPS.has(temperature)) {
      return bad(`pin.temperature must be one of hot, warm, cold — the same values note_pins accepts`);
    }
    const reason = "reason" in p ? p.reason : "";
    if (typeof reason !== "string") return bad("pin.reason must be a string");
    // Bounded on the way in — the row rides router lines and handoff citations, and a 100 KB
    // reason would make one pin decide what every surface costs.
    await store.set(path, temperature as "hot" | "warm" | "cold", reason.slice(0, 200));
    return Response.json({ ok: true, path, pin: { temperature, reason: reason.slice(0, 200) } });
  } catch (e) {
    // The store refused or did not answer. The pin state is whatever it was — say so.
    return bad(
      `${e instanceof Error ? e.message : String(e)} — the pin was not saved; note_pins holds its previous state`,
      502
    );
  }
}
