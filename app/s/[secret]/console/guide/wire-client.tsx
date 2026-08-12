"use client";
import { useEffect, useState } from "react";
import styles from "../console.module.css";

/**
 * The wire-up picker — pick your client, get the exact config, copy it working.
 *
 * Two rules, both inherited and both load-bearing:
 *
 * SCREENSHOTS ARE NOT CREDENTIALS. The connector secret is derivable here (it is in the
 * address bar), but it is never DISPLAYED — the visible snippet masks it as ••••. The copy
 * button assembles the real URL at click time, straight to the clipboard. Same standard as
 * the address bar itself: the operator can copy it; a photo of the screen learns nothing.
 *
 * THE SERVER TELLS NOTHING. MCP_TOKEN and GUEST_PATH_SECRET stay placeholders because the
 * server never sends their values to any page — those get pasted by the operator from
 * wherever the deployment's env lives. Only the path secret, which the browser already
 * holds, is completed client-side.
 */

interface Wire {
  id: string;
  name: string;
  door: "terminal" | "connector" | "guest";
  grants: string;
  where: string;
  /** Built against an origin and a DISPLAY secret; the copy path passes the real one. */
  snippet: (origin: string, secret: string) => string;
  note: string;
}

const MASK = "••••••••";

const WIRES: Wire[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    door: "terminal",
    grants: "reads · writes",
    where: "one command, any machine",
    snippet: (origin) =>
      `claude mcp add --transport http cortex \\\n  ${origin}/api/mcp \\\n  --header "Authorization: Bearer <MCP_TOKEN>"`,
    note: "Paste your MCP_TOKEN in place of the placeholder — the console never shows it.",
  },
  {
    id: "cursor",
    name: "Cursor",
    door: "terminal",
    grants: "reads · writes",
    where: "~/.cursor/mcp.json",
    snippet: (origin) =>
      JSON.stringify(
        {
          mcpServers: {
            cortex: {
              url: `${origin}/api/mcp`,
              headers: { Authorization: "Bearer <MCP_TOKEN>" },
            },
          },
        },
        null,
        2
      ),
    note: "Restart Cursor or toggle the server under Settings → MCP after saving.",
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    door: "terminal",
    grants: "reads · writes",
    where: "~/.gemini/settings.json",
    snippet: (origin) =>
      JSON.stringify(
        {
          mcpServers: {
            cortex: {
              httpUrl: `${origin}/api/mcp`,
              headers: { Authorization: "Bearer <MCP_TOKEN>" },
            },
          },
        },
        null,
        2
      ),
    note: "httpUrl, not url — url is the SSE transport; this server speaks streamable HTTP.",
  },
  {
    id: "claude-ai",
    name: "claude.ai",
    door: "connector",
    grants: "reads · writes",
    where: "Settings → Connectors → Add custom connector",
    snippet: (origin, secret) => `${origin}/api/s/${secret}/mcp`,
    note: "Connectors cannot send headers, so the secret rides the path. Add once on the web; iOS and desktop sync on their own.",
  },
  {
    id: "claude-ai-guest",
    name: "claude.ai (guest)",
    door: "guest",
    grants: "asks · proposes",
    where: "Settings → Connectors → Add custom connector",
    snippet: (origin) => `${origin}/api/g/<GUEST_PATH_SECRET>/mcp`,
    note: "A second Claude account that is not yours to trust with the pen — a work or org one, where somebody else sets the policy. Same screen as the connector above, deliberately a different URL: the guest secret goes in, no OAuth step and no token field appear, and the toolset that comes back is the scoped ask and the propose. If “Add custom connector” is missing from that account entirely, its org has custom connectors switched off and nothing on this side changes that.",
  },
  {
    id: "chatgpt",
    name: "ChatGPT / other apps",
    door: "guest",
    grants: "asks · proposes",
    where: "wherever that app takes an MCP server URL",
    snippet: (origin) => `${origin}/api/g/<GUEST_PATH_SECRET>/mcp`,
    note: "The guest door: scoped questions and suggestions, never the pen. If you trust the app like you trust yourself, give it the connector URL instead — that is a real decision, make it deliberately.",
  },
  {
    id: "other",
    name: "Anything else",
    door: "terminal",
    grants: "reads · writes",
    where: "any MCP client that speaks streamable HTTP",
    snippet: (origin) =>
      `URL:    ${origin}/api/mcp\nHeader: Authorization: Bearer <MCP_TOKEN>`,
    note: "The whole contract: one URL, one header. A client that insists on OAuth discovery will find none advertised and stay on the bearer.",
  },
];

export function WireClient({ guestOpen }: { guestOpen: boolean }) {
  const [pick, setPick] = useState("claude-code");
  const [copied, setCopied] = useState(false);
  // Derived after mount so the server-rendered payload carries only placeholders.
  const [origin, setOrigin] = useState("https://<host>");
  const [secret, setSecret] = useState<string | null>(null);

  useEffect(() => {
    // origin, not host: local dev is http, production is https — a hardcoded scheme lies in one of them.
    setOrigin(window.location.origin);
    // /s/<secret>/console/guide — the browser already holds this; the page never printed it.
    const m = window.location.pathname.match(/^\/s\/([^/]+)\//);
    setSecret(m ? m[1] : null);
  }, []);

  const w = WIRES.find((x) => x.id === pick)!;
  const shown = w.snippet(origin, MASK);
  const usesSecret = w.door === "connector";

  async function copy() {
    const real = usesSecret && secret ? w.snippet(origin, secret) : shown;
    try {
      await navigator.clipboard.writeText(real);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard denied — the snippet is still selectable by hand */
    }
  }

  return (
    <section>
      <div className={styles.sectionHead}>
        <span className={styles.label}>Wire up your client</span>
        <span className={styles.note}>
          pick the thing you use — the config comes out ready to paste
        </span>
      </div>
      <div className={styles.gScope}>
        {WIRES.map((x) => (
          <button
            key={x.id}
            type="button"
            className={`${styles.gArea}${x.id === pick ? " " + styles.gOn : ""}`}
            aria-pressed={x.id === pick}
            onClick={() => {
              setPick(x.id);
              setCopied(false);
            }}
          >
            {x.name}
          </button>
        ))}
      </div>
      <div className={styles.wireMeta}>
        <span className={styles.note}>
          path {w.door === "terminal" ? "01 · terminal" : w.door === "connector" ? "02 · connector" : "03 · guest"} ·{" "}
          {w.grants} · {w.where}
        </span>
        <button type="button" className={styles.rdBtn} onClick={copy}>
          {copied ? "copied" : usesSecret ? "copy with secret" : "copy"}
        </button>
      </div>
      <pre className={styles.pre}>{shown}</pre>
      <p className={styles.pathNote}>
        {w.note}
        {w.door === "guest" &&
          (guestOpen
            ? " This door is open on this deployment. Every guest surface shares the one secret, so rotating GUEST_PATH_SECRET revokes all of them at once — and none of your trusted doors."
            : " This door is CLOSED on this deployment — set GUEST_PATH_SECRET to open it.")}
        {usesSecret &&
          " The secret is masked on screen — copy carries the real URL, a screenshot carries nothing."}
      </p>
    </section>
  );
}
