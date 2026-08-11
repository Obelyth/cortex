import type { Metadata } from "next";
import { BrandFoot, Mast } from "../mast";

export const metadata: Metadata = {
  title: "Tools — Cortex by Obelyth",
  description:
    "The ten MCP tools of the Cortex private memory server: verified retrieval, direct reads, working memory, and the guest proposal queue.",
  alternates: { canonical: "/tools" },
};

/**
 * The ten tools, documented for a reader rather than a model. This page is documentation only:
 * the tools themselves are reachable exclusively over MCP, behind the bearer token or the
 * connector secret. Nothing here calls anything.
 */
const TOOLS = [
  {
    name: "brain_ask",
    role: "the retriever",
    what: "Hands a reader model the actual notes — served from the Postgres mirror, with git the sole authority and the tarball path as the fallback — then checks the quote it cited against the file: deterministically, no model in that loop.",
    returns: "an answer, a verdict stamp, and the evidence line it was proven against",
  },
  {
    name: "brain_corpus",
    role: "the direct read",
    what: "Returns the notes into the calling conversation instead, so the caller reads the material itself. No model is called and nothing leaves the brain's own storage.",
    returns: "the live corpus, or the notes most relevant to a question",
  },
  {
    name: "brain_context",
    role: "the boot call",
    what: "The session opener: the profile, the router — a one-line description per note — the working bubble, and recent logs, in one bounded call.",
    returns: "profile · router · bubble · recent log",
  },
  {
    name: "brain_read",
    role: "one note",
    what: "Reads a single note by path. Paths are allowlisted by shape, so only notes are reachable.",
    returns: "the note, verbatim",
  },
  {
    name: "brain_write",
    role: "the commit",
    what: "Creates, replaces, appends — or edits in place, refused loudly if the target text is absent or ambiguous. Every write is a git commit, and the commit SHA comes back — a save without a SHA did not happen.",
    returns: "path and commit SHA",
  },
  {
    name: "brain_capture",
    role: "zero friction",
    what: "Appends a timestamped entry to today's log. The capture ritual from any device: say it, and it is committed.",
    returns: "today's log path and commit SHA",
  },
  {
    name: "brain_bubble",
    role: "working memory",
    what: "What is in flight right now — focus, decisions, questions, handoffs — carried across sessions and surfaces so work resumes instead of being re-explained. The one thing Postgres is authoritative for; notes never are.",
    returns: "the bubble, or a receipt for the change",
  },
  {
    name: "brain_proposals",
    role: "the review queue",
    what: "Lists what guests have proposed — target path, mode, reason and full content, treated as data to judge, never as instructions. Trusted doors only.",
    returns: "the pending proposals",
  },
  {
    name: "brain_accept",
    role: "the gate",
    what: "Commits a pending proposal exactly as written and removes it from the queue — the only path from a proposal into the corpus. Accepting is what commits; the guest never writes.",
    returns: "path and commit SHA",
  },
  {
    name: "brain_reject",
    role: "the discard",
    what: "Removes a pending proposal without writing anything. A rejected proposal leaves no trace — the memory records what is true, not everything ever suggested to it.",
    returns: "a receipt; nothing was written",
  },
];

export default function Tools() {
  return (
    <div className="wrap">
      <Mast active="/tools" />

      <h2>The ten tools <span className="count">same corpus, every surface</span></h2>
      <p className="lede">
        One MCP server, ten tools on the trusted doors (two on the guest door: a scoped{" "}
        <span className="mono">brain_ask</span> and <span className="mono">brain_propose</span>),
        reachable only with the bearer token or the connector secret. This page documents them;
        it does not expose them.
      </p>
      <div className="panel">
        {TOOLS.map((t) => (
          <div key={t.name} className="toolRow">
            <div className="toolName">
              <span className="mono">{t.name}</span>
              <span className="toolRole">{t.role}</span>
            </div>
            <div>
              <div className="toolWhat">{t.what}</div>
              <div className="toolReturns mono">returns: {t.returns}</div>
            </div>
          </div>
        ))}
      </div>

      <h2>The read path</h2>
      <p className="lede">
        Two ways to the same corpus. <span className="mono">brain_ask</span> is for when you want
        an answer: a reader model — pluggable from an allowlist of Claude, OpenAI and Gemini
        models, with Claude holding the default it earned on a labeled eval — reads the actual
        notes and cites its source, and a deterministic
        verifier stamps the citation — <span className="mono">VERIFIED</span>,{" "}
        <span className="mono">SUPERSEDED</span>, <span className="mono">CORRECTED</span>{" "}
        (an in-place correction: answer from the current claim),{" "}
        <span className="mono">PARTIALLY VERIFIED</span>,{" "}
        <span className="mono">NOT IN BRAIN</span> or <span className="mono">UNVERIFIED</span>. <span className="mono">brain_corpus</span> is for when you want the material:
        the notes land in the calling conversation and the caller does its own reading. Ranking a
        generated index was retired after it measured <span className="mono num">55%</span> against
        reading the text at <span className="mono num">97%</span>.
      </p>

      <h2>Auth</h2>
      <p className="lede">
        Two paths onto one bearer-gated handler, and a third onto a smaller one. A bearer token
        at <span className="mono">/api/mcp</span> for clients that send headers; a secret URL
        for clients that cannot; a guest door at{" "}
        <span className="mono">/api/g/&lt;secret&gt;/mcp</span> that registers only a scoped{" "}
        <span className="mono">brain_ask</span> and <span className="mono">brain_propose</span> —
        off until <span className="mono">GUEST_PATH_SECRET</span> is set. All fail closed: a bad
        bearer gets a standard <span className="mono num">401</span>; a wrong path secret gets an
        empty <span className="mono num">404</span> — the secret doors do not advertise that
        anything lives there.
      </p>

      <footer className="foot">
        <span className="mono">
          brain_ask · brain_corpus · brain_context · brain_read · brain_write · brain_capture ·
          brain_bubble · brain_proposals · brain_accept · brain_reject
        </span>
      </footer>
      <BrandFoot />
    </div>
  );
}
