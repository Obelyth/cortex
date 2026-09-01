import { WireClient } from "./wire-client";
import { Reveal } from "../reveal";
import styles from "../console.module.css";

/**
 * Connect — the guide's whole body, now a section of settings (the v4 merge). Who does what,
 * the three doors, the wire-up picker, the toolset by door. Content unchanged; the merge is an
 * address change, and the old /guide and /readers segments redirect here so nothing anyone
 * bookmarked goes dark.
 */
export function ConnectSection({
  guestOpen,
  bearerSet,
  activeModel,
  activeSource,
  guestReader,
}: Readonly<{
  guestOpen: boolean;
  bearerSet: boolean;
  activeModel: string | null;
  activeSource: string | null;
  guestReader: string;
}>) {
  /**
   * The four roles, before any wiring: who holds the pen, who reads, who checks, who may only
   * ask. Every confusion this screen exists to clear ("who is reading? who is writing? what
   * does hooking up a non-Claude thing mean?") is one of these cells. The pen and the reader
   * are DIFFERENT ROLES on purpose — that separation is the product: swap either without
   * touching the other, and the verifier vouches for both.
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
        : "no reader resolves — see the controls above",
    },
    {
      name: "The verifier",
      who: "deterministic — no model",
      does: "stamps every citation",
      detail: "checks the quote against the file at its commit; the stamp is the product",
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
      open: true,
      state: "open · this console rides the same secret",
      wire: `https://<host>/api/s/<CONNECTOR_PATH_SECRET>/mcp`,
      note: "Same full toolset as the terminal — the secret in the path stands in for the header.",
    },
    {
      num: "03",
      name: "Guest",
      who: "Assistants you do not control — another person's model, or one you use but do not trust with the pen.",
      grants: "asks · proposes — never writes",
      open: guestOpen,
      state: guestOpen ? "open · scoped on the readers screen" : "closed · set GUEST_PATH_SECRET",
      wire: `https://<host>/api/g/<GUEST_PATH_SECRET>/mcp`,
      note: "Questions are answered by a Claude reader from the areas you share; suggestions wait on the attention screen until accepted. The corpus itself is never handed over.",
      // The only path with a policy attached, so it is the only one that links onward.
      link: { href: "settings", label: "scope it" },
    },
  ];

  const tools: [string, string, "trusted" | "guest" | "both"][] = [
    ["brain_ask", "a reader answers, cites, and the verifier stamps the citation — scoped and citation-free on the guest door", "both"],
    ["brain_corpus", "hands the notes to the calling model instead — no reader, no egress", "trusted"],
    ["brain_context", "profile · index · the last week of logs, one call", "trusted"],
    ["brain_handoff", "one call resumes a project — page, bubble items, log mentions, graph neighbours, every piece cited", "trusted"],
    ["brain_read", "one note by path", "trusted"],
    ["brain_write", "create, replace, append — returns the commit SHA", "trusted"],
    ["brain_capture", "timestamped append to today's log, from any device", "trusted"],
    ["brain_propose", "leave a suggestion for review — commits nothing", "guest"],
    ["brain_proposals · accept · reject", "review what guests left; accepting is what commits", "trusted"],
  ];

  return (
    <>
      <section className="card">
        <div className={styles.sectionHead}>
          <span className={styles.label}>Who does what</span>
          <span className={styles.note}>
            the pen and the reader are different roles — that separation is the product
          </span>
        </div>
        <div className={styles.roleGrid}>
          {roles.map((r) => (
            <div key={r.name} className={styles.roleCell}>
              <div className={styles.label}>{r.name}</div>
              <div className={styles.roleWho}>{r.who}</div>
              <div className={styles.roleDoes}>{r.does}</div>
              <div className={styles.note}>{r.detail}</div>
            </div>
          ))}
        </div>
      </section>


      <section className="card">
        <div className={styles.sectionHead}>
          <span className={styles.label}>Choose your path</span>
          <span className={styles.note}>
            two questions decide it — do you trust the client, and can it send a header
          </span>
        </div>
        <div className={styles.pathGrid}>
          {paths.map((p) => (
            <div key={p.num} className={styles.pathCard}>
              <div className={styles.pathHead}>
                <span className={styles.pathNum}>path {p.num}</span>
                <span className={styles.pathName}>{p.name}</span>
                <span className={styles.pathGrants}>{p.grants}</span>
              </div>
              <div className={styles.pathState}>
                <span className={p.open ? styles.dotLive : styles.dotIdle} />
                <span className={styles.note}>{p.state}</span>
                {p.link && (
                  <a className={`${styles.railLink} ${styles.pathLink}`} href={p.link.href}>
                    {p.link.label}
                  </a>
                )}
              </div>
              <p className={styles.pathWho}>{p.who}</p>
              <pre className={styles.pre}>{p.wire}</pre>
              <p className={styles.pathNote}>{p.note}</p>
            </div>
          ))}
        </div>
      </section>


      <WireClient guestOpen={guestOpen} />


      <div className={styles.twoCol}>
        <section className={styles.block}>
          <div className={styles.blockHead}><span>Who reads the answers</span></div>
          <p className={styles.prose}>
            <Reveal label="the reader contract">
              The brain is markdown, git and a deterministic verifier, so which model reads it is a
              setting rather than an assumption. Every reader is held to one contract — a refusal
              or truncation throws rather than masquerading as <b>NOT IN BRAIN</b> — and the
              resolution order is: the call&rsquo;s own choice, then the{" "}
              <a className={styles.railLink} href="settings">settings</a> screen&rsquo;s default,
              then <span className={styles.mono}>READER_MODEL</span>, then the built-in. Guest
              questions are always read by a Claude model, whatever the default says. Trust comes
              from the verification, not from the model.
            </Reveal>
          </p>
          <div className={styles.blockHead}><span>The rituals</span></div>
          <p className={styles.prose}>
            <b>Boot</b> — open with brain_context. <b>Capture</b> — &ldquo;remember: …&rdquo;
            becomes a commit. <b>Wrap up</b> — outcomes to project pages and the daily log.
          </p>
        </section>

        <section className={styles.block}>
          <div className={styles.blockHead}>
            <span>The toolset, by door</span>
            <span className={styles.dim}>paths 01–02 are trusted · path 03 is the guest</span>
          </div>
          {tools.map(([name, what, door]) => (
            <div key={name} className={styles.toolRow}>
              <span className={styles.mono}>{name}</span>
              <span className={styles.toolWhat}>{what}</span>
              <span
                className={`${styles.toolDoor}${door !== "trusted" ? " " + styles.toolDoorGuest : ""}`}
              >
                {door === "both" ? "all doors" : door}
              </span>
            </div>
          ))}
          <div className={styles.footNote}>
            full reference on the public site: /tools · /guide · /map
          </div>
        </section>
      </div>
    </>
  );
}
