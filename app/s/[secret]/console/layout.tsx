import { cookies } from "next/headers";
import { requireSecret } from "@/lib/gate";
import { Kinetic } from "./kinetic";
import { DeviceVisit } from "./device-visit";
import { LensProvider } from "./lens";
import { Masthead } from "./masthead";
import { StatusChip } from "./status-chip";
import { GROUND_COOKIE, groundFrom } from "./ground";
import "./theme.css";
import "./console.css";

// Every screen stays request-bound. The layout gates first; each page owns its own data reads.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function ConsoleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ secret: string }>;
}) {
  const secret = await requireSecret(params);
  const jar = await cookies();
  const ground = groundFrom(jar.get(GROUND_COOKIE)?.value);
  const build = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) ?? "dev";

  return (
    <div className="conRoot" data-ground={ground}>
      <Kinetic />
      <DeviceVisit />
      <LensProvider>
        <Masthead
          secret={secret}
          mode={{ text: "status checking", tone: "off" }}
          sha=""
          commitUrl={null}
          status={<StatusChip />}
        />

        {/* tabIndex={-1} is not decoration: it is the last step of the overlay's focus return
            (focus-return.ts, step 3). An element with no tabindex ignores .focus() outright, so
            without this the fallback lands on <body> — focus nowhere, announced as nothing — which
            is the case the rule exists to avoid. -1 keeps it out of the tab order, and the console
            styles :focus-visible only, so a programmatic focus draws no ring. */}
        <main className="conBody" tabIndex={-1}>{children}</main>

        <footer className="conFoot">
          <span className="conFootMark">Cortex by Obelyth</span>
          <span className="conSpacer" />
          <span className="conFootTag">
            build {build}
          </span>
          <a className="conFootLink" href="https://github.com/Obelyth/cortex" target="_blank" rel="noreferrer">GitHub</a>
          <span className="conFootTag">© 2026 Obelyth</span>
        </footer>
      </LensProvider>
    </div>
  );
}
