import { safeEqualStrings } from "@/lib/auth";
import {
  STAMP_COOKIE,
  failDelay,
  gateAllowed,
  gateFailed,
  passcodeConfigured,
  passcodeMatches,
  readCookie,
  stampIsValid,
  stampValue,
} from "@/lib/stamp";

/**
 * The console's front door, as a route handler because pages cannot set cookies — and now a
 * two-step door. The URL's secret proves the link; it no longer stamps the device by itself.
 * A first visit answers a passcode prompt instead, and only the right passcode sets the
 * httpOnly device stamp (see lib/stamp.ts for what the stamp is and why the link can't forge
 * it). A stamped device is forwarded straight through, so the entry link keeps working as the
 * bookmark it always was. A wrong secret gets the same empty 404 as every other gate here:
 * nothing lives at this path, and no prompt ever confirms that something does.
 */
export const dynamic = "force-dynamic";

const YEAR_SECONDS = 31536000;

function stampedRedirect(secret: string, status: 303 | 307): Response {
  const headers = new Headers();
  // The stamp is re-set on every pass-through, so a device the owner actually uses never ages out.
  // Same scoping as the old cookie: httpOnly (no script access), lax (sent on top-level
  // navigation, not cross-site subresources), a year.
  headers.set(
    "Set-Cookie",
    `${STAMP_COOKIE}=${stampValue()}; Path=/; Max-Age=${YEAR_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
  );
  headers.set("Location", `/s/${secret}/console/overview`);
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status, headers });
}

/**
 * The prompt, inline rather than a page: a page.tsx cannot share this segment with the route
 * handler that must set the cookie, and the prompt must not depend on anything the console
 * shell loads — it renders before the device has proven anything. Static strings only; nothing
 * a visitor types is ever echoed back into markup. Styled to the console's direction contract
 * (paper, ink, hairlines, one dashed signal rule, mono labels), with system fallbacks because
 * the root layout's self-hosted faces don't reach a raw Response.
 */
function promptPage(status: number, note?: string): Response {
  const noteLine = note ? `<p class="note">${note}</p>` : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Cortex</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; margin: 0; }
  body {
    min-height: 100svh; display: grid; place-items: center;
    background: #f0efed; color: #111315;
    font-family: Archivo, system-ui, -apple-system, sans-serif;
  }
  main { width: min(340px, calc(100vw - 48px)); }
  .rule { border-top: 2px dashed #d8500f; margin-bottom: 28px; }
  h1 { font-size: 34px; font-weight: 800; letter-spacing: -0.02em; line-height: 0.9; }
  .label {
    font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px; font-weight: 500; letter-spacing: 0.18em; color: #5f666d;
    display: block; margin: 26px 0 8px;
  }
  input {
    width: 100%; padding: 10px 12px; font: inherit; font-size: 15px;
    background: #f7f6f4; color: #111315;
    border: 1px solid rgba(17, 19, 21, 0.16); border-radius: 0; outline: none;
  }
  input:focus { border-color: #d8500f; }
  button {
    margin-top: 14px; width: 100%; padding: 10px 12px; cursor: pointer;
    font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px; font-weight: 500; letter-spacing: 0.18em;
    background: #111315; color: #f0efed; border: 1px solid #111315; border-radius: 0;
  }
  .note {
    margin-top: 14px; color: #e8695f;
    font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px; letter-spacing: 0.04em;
  }
</style>
</head>
<body>
<main>
  <div class="rule"></div>
  <h1>Cortex</h1>
  <form method="post" action="">
    <label class="label" for="passcode">PASSCODE</label>
    <input id="passcode" name="passcode" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">ENTER</button>
  </form>
  ${noteLine}
</main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Only ever seen with the right secret in hand — it names the fix for the operator, and an
 *  env var is nothing a visitor can set. */
function lockedPage(status: number): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Cortex</title>
<style>
  body {
    min-height: 100svh; display: grid; place-items: center; margin: 0;
    background: #f0efed; color: #111315;
    font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px; line-height: 1.55;
  }
  main { width: min(420px, calc(100vw - 48px)); }
  .rule { border-top: 2px dashed #d8500f; margin-bottom: 20px; }
</style>
</head>
<body>
<main>
  <div class="rule"></div>
  <p>CONSOLE LOCKED — CONSOLE_PASSCODE is not configured.</p>
  <p>Set it in the deployment env and redeploy; the console fails closed until then.</p>
</main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function secretOk(secret: string): boolean {
  const expected = process.env.CONNECTOR_PATH_SECRET;
  return Boolean(expected && safeEqualStrings(secret, expected));
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ secret: string }> },
): Promise<Response> {
  const { secret } = await ctx.params;
  if (!secretOk(secret)) return new Response(null, { status: 404 });
  if (stampIsValid(readCookie(req.headers.get("cookie"), STAMP_COOKIE))) {
    return stampedRedirect(secret, 307);
  }
  if (!passcodeConfigured()) return lockedPage(200);
  return promptPage(200);
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ secret: string }> },
): Promise<Response> {
  const { secret } = await ctx.params;
  if (!secretOk(secret)) return new Response(null, { status: 404 });

  // Same-origin only, same shape as gateConsolePost: a cross-site form must not be able to
  // spend guesses (or ride a stamped device) from somewhere else.
  const origin = req.headers.get("origin");
  if (origin) {
    let from: string;
    try {
      from = new URL(origin).host;
    } catch {
      return new Response(null, { status: 403 });
    }
    const mine = new Set([req.headers.get("host"), new URL(req.url).host].filter(Boolean));
    if (!mine.has(from)) return new Response(null, { status: 403 });
  }

  if (!passcodeConfigured()) return lockedPage(403);

  let candidate: string;
  try {
    const form = await req.formData();
    candidate = String(form.get("passcode") ?? "");
  } catch {
    return new Response(null, { status: 400 });
  }

  // First address in x-forwarded-for is the client as Vercel saw it; "unknown" still meters
  // through the global counter.
  const address = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!(await gateAllowed(address))) {
    await failDelay();
    // Refused before the compare: a locked-out guess learns nothing, not even "wrong".
    return promptPage(429, "too many failed attempts — try again in a few minutes");
  }

  if (passcodeMatches(candidate)) {
    return stampedRedirect(secret, 303);
  }

  await gateFailed(address);
  await failDelay();
  return promptPage(401, "wrong passcode");
}
