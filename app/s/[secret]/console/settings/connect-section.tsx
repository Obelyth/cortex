import { WireClient } from "./wire-client";
import roster from "@/lib/tool-roster.json";

const TOOL_COPY: Record<string, string> = {
  brain_accept: "accept one reviewed guest proposal and commit it",
  brain_ask: "a reader answers; the verifier checks the cited quote, but does not prove the answer correct — guest asks are scoped and citation-free",
  brain_bubble: "working memory operations: list · add · update · file · drop",
  brain_capture: "timestamped append to today's log, from any device",
  brain_context: "profile · router · recent logs · working state, one boot call",
  brain_corpus: "sends note text to the calling client directly; no separate reader model call",
  brain_handoff: "resume one project with its page, working state, log mentions and graph neighbours",
  brain_proposals: "list the guest proposals waiting for trusted review",
  brain_read: "return one note by exact path",
  brain_reject: "discard one pending guest proposal without committing it",
  brain_write: "write operations: create · replace · append · edit — returns the commit SHA",
  brain_propose: "leave a suggestion for review — commits nothing",
};

/**
 * Connect — the guide's whole body, a section of settings since the v4 merge and restated in the
 * v2 idiom under the Doors group: who does what, the three doors as bezelled panels, the wire-up
 * picker, and the toolset by door. Setup links stay within the current Settings screen.
 */
export function ConnectSection({
  guestOpen,
  guestMissing = [],
  guestStoreState = "store",
  bearerSet,
  activeModel,
  activeSource,
  guestReader,
  initialWire,
}: Readonly<{
  guestOpen: boolean;
  guestMissing?: readonly string[];
  guestStoreState?: "store" | "unconfigured" | "unreachable";
  bearerSet: boolean;
  activeModel: string | null;
  activeSource: string | null;
  guestReader: string;
  /** Optional initial selection for deterministic server-rendered fixtures. */
  initialWire?: string;
}>) {
  const guestState = guestOpen
    ? "open · scoped above"
    : guestMissing.length
      ? `closed · missing ${guestMissing.join(" + ")}`
      : guestStoreState === "unreachable"
        ? "unavailable · guest policy store did not answer"
        : guestStoreState === "unconfigured"
          ? "closed · guest policy store is not configured"
          : "closed · guest prerequisites unavailable";
  /**
   * The four roles, before any wiring: who holds the pen, who reads, who checks, who may only
   * ask. Every confusion this section exists to clear ("who is reading? who is writing? what
   * does hooking up a non-Claude thing mean?") is one of these cells. The pen and the reader
   * are DIFFERENT ROLES on purpose — that separation is the product: swap either without
   * touching the other. The verifier checks citation fidelity; it does not judge either role.
   */
  const roles = [
    {
      name: "The pen",
      who: "your orchestrator",
      does: "writes commits · reviews proposals",
      detail: "any MCP client on paths 01–02 — the house runs Claude, nothing requires it",
    },
    {
      name: "The reader",
      who: activeModel ?? "unresolved",
      does: "answers brain_ask",
      detail: activeModel
        ? `chosen above · ${activeSource === "console" ? "set in this console" : activeSource === "env" ? "from READER_MODEL" : "the built-in default"}`
        : "no reader resolves — see the Reader group above",
    },
    {
      name: "The verifier",
      who: "deterministic — no model",
      does: "checks every cited quote",
      detail: "proves the quote exists in that file at its commit; it does not prove the answer is correct",
    },
    {
      name: "Guests",
      who: guestOpen ? "door open" : "door closed",
      does: "ask (scoped) · propose",
      detail: `read for them by ${guestReader}, from the areas you share — never the pen`,
    },
  ];

  const paths = [
    {
      num: "01",
      name: "Terminal",
      who: "Your orchestrator, on a machine you control — Claude Code, or any MCP client that can send an Authorization header.",
      grants: "reads · writes",
      open: bearerSet,
      state: bearerSet ? "open · bearer set" : "closed · MCP_TOKEN not set",
      wire: `claude mcp add --transport http cortex \\
  https://<host>/api/mcp \\
  --header "Authorization: Bearer <MCP_TOKEN>"`,
      note: "Full toolset. The header is the credential; any client that can send one connects the same way.",
    },
    {
      num: "02",
      name: "Connector",
      who: "Trusted clients that cannot send headers — claude.ai custom connectors. Add once on the web and it syncs to iOS and desktop.",
      grants: "reads · writes",
      open: bearerSet,
      state: bearerSet ? "open · this console rides the path secret and the server bearer is set" : "closed · MCP_TOKEN not set",
      wire: `https://<host>/api/s/<CONNECTOR_PATH_SECRET>/mcp`,
      note: "Same full toolset as the terminal — the secret in the path stands in for the header.",
    },
    {
      num: "03",
      name: "Guest",
      who: "Assistants you do not control — another person's model, or one you use but do not trust with the pen.",
      grants: "asks · proposes — never writes",
      open: guestOpen,
      state: guestState,
      wire: `https://<host>/api/g/<GUEST_PATH_SECRET>/mcp`,
      note: "Questions are answered by a Claude reader from the areas you share; suggestions wait on the attention screen until accepted. The corpus itself is never handed over.",
      // The only path with a policy attached, so it is the only one that links onward — up the
      // sheet to the group that scopes it.
      link: { href: "#setGuest", label: "scope it" },
    },
  ];

  const trusted = new Set(roster.trusted);
  const guest = new Set(roster.guest);
  const tools: [string, string, "trusted" | "guest" | "both"][] = [
    ...roster.trusted,
    ...roster.guest.filter((name) => !trusted.has(name)),
  ].map((name) => [
    name,
    TOOL_COPY[name] ?? "registered tool",
    trusted.has(name) && guest.has(name) ? "both" : guest.has(name) ? "guest" : "trusted",
  ]);

  return (
    <>
      <div className="setWide">
        <div className="setBlockHead">
          <h3 className="setEyebrow">Who does what</h3>
          <span className="setBlockNote">the pen and the reader are different roles — that separation is the product</span>
        </div>
        <div className="setRoles">
          {roles.map((r) => (
            <div key={r.name} className="setRole">
              <span className="setRoleName">{r.name}</span>
              <span className="setRoleWho">{r.who}</span>
              <span className="setRoleDoes">{r.does}</span>
              <span className="setRoleDetail">{r.detail}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="setWide">
        <div className="setBlockHead">
          <h3 className="setEyebrow">Choose your path</h3>
          <span className="setBlockNote">two questions decide it — do you trust the client, and can it send a header</span>
        </div>
        <div className="setDoors">
          {paths.map((p) => (
            <div key={p.num} className="setDoor">
              <div className="setDoorHead">
                <span className="setDoorNum">path {p.num}</span>
                <span className="setDoorName">{p.name}</span>
                <span className="setDoorGrants">{p.grants}</span>
              </div>
              <div className="setDoorState">
                <span className={p.open ? "setDot setDotOn" : "setDot"} aria-hidden />
                <span className="setBlockNote">{p.state}</span>
                {p.link && (
                  <a className="setDoorLink" href={p.link.href}>
                    {p.link.label}
                  </a>
                )}
              </div>
              <p className="setDoorWho">{p.who}</p>
              <pre className="setPre">{p.wire}</pre>
              <p className="setDoorNote">{p.note}</p>
            </div>
          ))}
        </div>
      </div>

      <WireClient
        guestOpen={guestOpen}
        guestMissing={guestMissing}
        guestStoreState={guestStoreState}
        initialWire={initialWire}
      />

      <div className="setWide">
        <div className="setBlockHead">
          <h3 className="setEyebrow">The toolset, by door</h3>
          <span className="setBlockNote">paths 01–02 are trusted · path 03 is the guest</span>
        </div>
        <div className="setTools">
          {tools.map(([name, what, door]) => (
            <div key={name} className="setTool">
              <span className="setToolName">{name}</span>
              <span className="setToolWhat">{what}</span>
              <span className={door !== "trusted" ? "setToolDoor setToolDoorGuest" : "setToolDoor"}>
                {door === "both" ? "all doors" : door}
              </span>
            </div>
          ))}
        </div>
        <p className="setProse">
          <b>Who reads the answers.</b> The brain is markdown, git and a deterministic verifier, so which model reads it is a
          setting rather than an assumption. Every reader is held to one contract — a refusal or truncation throws rather
          than masquerading as <b>NOT IN BRAIN</b> — and the resolution order is: the call&rsquo;s own choice, then the
          default set above, then <code>READER_MODEL</code>, then the built-in. Guest questions are always read by a Claude
          model, whatever the default says. A VERIFIED stamp proves that the cited quote matches the named file at that
          commit; it does not prove that the reader&rsquo;s answer or conclusion is semantically correct.
        </p>
        <p className="setProse">
          <b>The rituals.</b> Boot — open with brain_context. Capture — &ldquo;remember: …&rdquo; becomes a commit. Wrap up
          — outcomes to project pages and the daily log.
        </p>
        <p className="setBlockNote">
          Setup help: <a href="#setDoors">Services &amp; deployment</a> · <a href="#setReader">Answering model</a>
        </p>
      </div>
    </>
  );
}
