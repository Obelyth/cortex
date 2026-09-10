"use client";
import { useEffect, useRef, useState } from "react";
import { ClipboardFailure, copyExactText } from "./clipboard";

/**
 * The wire-up picker — pick your client, get the exact config, copy it working.
 *
 * Two rules, both inherited and both load-bearing:
 *
 * SCREENSHOTS ARE NOT CREDENTIALS BY DEFAULT. The connector secret is derivable here (it is in
 * the address bar), but the normal snippet masks it as ••••. The copy button assembles the real
 * URL at click time. If browser clipboard permission is refused after that explicit action, the
 * screen says so and holds the exact URL behind a second explicit click (Reveal) — a screenshot
 * of the failure carries nothing either — instead of failing silently.
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

export function WireClient({
  guestOpen,
  guestMissing = [],
  guestStoreState = "store",
  initialWire = "claude-code",
}: {
  guestOpen: boolean;
  guestMissing?: readonly string[];
  guestStoreState?: "store" | "unconfigured" | "unreachable";
  initialWire?: string;
}) {
  const [pick, setPick] = useState(initialWire);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [fallback, setFallback] = useState<string | null>(null);
  // Derived after mount so the server-rendered payload carries only placeholders.
  const [origin, setOrigin] = useState("https://<host>");
  const [secret, setSecret] = useState<string | null>(null);
  const copyAttempt=useRef(0),reset=useRef<ReturnType<typeof setTimeout>|null>(null);
  const invalidateCopy=()=>{copyAttempt.current++;if(reset.current!==null)clearTimeout(reset.current);reset.current=null;};
  useEffect(()=>()=>invalidateCopy(),[]);

  useEffect(() => {
    // origin, not host: local dev is http, production is https — a hardcoded scheme lies in one of them.
    setOrigin(window.location.origin);
    // /s/<secret>/console/settings — the browser already holds this; the page never printed it.
    const m = window.location.pathname.match(/^\/s\/([^/]+)\//);
    setSecret(m ? m[1] : null);
  }, []);

  const w = WIRES.find((x) => x.id === pick)!;
  const shown = w.snippet(origin, MASK);
  const usesSecret = w.door === "connector";

  async function copy() {
    invalidateCopy();const own=copyAttempt.current;
    const real = usesSecret && secret ? w.snippet(origin, secret) : shown;
    const result = await copyExactText(real);
    if(copyAttempt.current!==own)return;
    if (result.ok) {
      setCopyState("copied");
      setFallback(null);
      reset.current=setTimeout(() => {if(copyAttempt.current===own)setCopyState("idle");reset.current=null;}, 1600);
    } else {
      setCopyState("failed");
      setFallback(result.fallback);
    }
  }

  return (
    <div className="setWide">
      <div className="setBlockHead">
        <h3 className="setEyebrow">Wire up your client</h3>
        <span className="setBlockNote">pick the thing you use — the config comes out ready to paste</span>
      </div>
      <div className="setWire">
        <div className="setChips" role="group" aria-label="Client">
          {WIRES.map((x) => (
            <button
              key={x.id}
              type="button"
              className="setChip"
              aria-pressed={x.id === pick}
              onClick={() => {
                invalidateCopy();
                setPick(x.id);
                setCopyState("idle");
                setFallback(null);
              }}
            >
              {x.name}
            </button>
          ))}
        </div>
        <div className="setWireMeta">
          <span className="setBlockNote">
            path {w.door === "terminal" ? "01 · terminal" : w.door === "connector" ? "02 · connector" : "03 · guest"} ·{" "}
            {w.grants} · {w.where}
          </span>
          <button type="button" className="setBtn" onClick={() => void copy()} aria-live="polite">
            {copyState === "copied" ? "copied" : copyState === "failed" ? "copy failed" : usesSecret ? "copy with secret" : "copy"}
          </button>
        </div>
        <pre className="setPre">{shown}</pre>
        {fallback && <ClipboardFailure text={fallback} />}
        <p className="setWireNote">
          {w.note}
          {w.door === "guest" &&
            (guestOpen
              ? " This door is open on this deployment."
              : guestMissing.length
                ? ` This door is CLOSED on this deployment — missing ${guestMissing.join(" + ")}.`
                : guestStoreState === "unreachable"
                  ? " This door is UNAVAILABLE — the guest policy store did not answer."
                  : guestStoreState === "unconfigured"
                    ? " This door is CLOSED — the guest policy store is not configured."
                    : " This door is CLOSED — its prerequisites are unavailable.")}
          {usesSecret &&
            (fallback
              ? " Copy failed — the browser refused the clipboard. Press reveal above to select the exact URL by hand, and hide it again before a screenshot."
              : " The secret is masked on screen — copy carries the real URL, a screenshot carries nothing.")}
        </p>
      </div>
    </div>
  );
}
