import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { STAMP_COOKIE, stampIsValid } from "@/lib/stamp";
// From nav.ts, not tabs.tsx: tabs.tsx is "use client", and a Server Component reading a named
// export off a client module gets a client-reference stub back, not the string — see nav.ts.
import { LANDING_SEG } from "@/app/s/[secret]/console/nav";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

/**
 * The root IS the dashboard — for this operator's devices. Answering the passcode prompt once
 * (/s/<secret>/console) stamps the device cookie; from then on the bare domain forwards
 * straight to the board. Any device without the stamp gets a 404: there is no public page,
 * no name, no hint. The deployment does not advertise what the secret protects — and a cookie
 * that merely repeats the path secret stopped being a stamp when the passcode arrived, so a
 * pre-passcode device lands here on 404 once and re-enters through the prompt.
 */
export default async function Root() {
  const jar = await cookies();
  const expected = process.env.CONNECTOR_PATH_SECRET;
  if (expected && stampIsValid(jar.get(STAMP_COOKIE)?.value)) {
    // Location header only — the secret never appears in markup.
    redirect(`/s/${expected}/console/${LANDING_SEG}`);
  }
  notFound();
}
