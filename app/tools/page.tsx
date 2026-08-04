import { BrandFoot, Mast } from "../mast";

/**
 * The nine tools, documented for a reader rather than a model. This page is documentation only:
 * the tools themselves are reachable exclusively over MCP, behind the bearer token or the
 * connector secret. Nothing here calls anything.
 */
const TOOLS = [
  {
    name: "brain_ask",
    role: "the retriever",
    what: "Fetches the whole live corpus in one tarball, hands a reader model the actual notes, and then checks the quote it cited against the file — deterministically, no model in that loop.",
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
    what: "The session opener: the profile, the index, and the last week of log entries, in one call.",
    returns: "profile · index · recent log",
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
    what: "Creates, replaces, or appends to a note. Every write is a git commit, and the commit SHA comes back — a save without a SHA did not happen.",
    returns: "path and commit SHA",
  },
  {
    name: "brain_capture",
    role: "zero friction",
    what: "Appends a timestamped entry to today's log. The capture ritual from any device: say it, and it is committed.",
    returns: "today's log path and commit SHA",
  },
];

export default function Tools() {
  return (
    <div className="wrap">
      <Mast active="/tools" />

      <h2>The nine tools <span className="count">same corpus, every surface</span></h2>
      <p className="lede">
        One MCP server, nine tools on the trusted doors (two on the guest door), reachable only with the bearer token or the connector
        secret. This page documents them; it does not expose them.
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
        an answer: a reader model reads the actual notes and cites its source, and a deterministic
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
          brain_ask · brain_corpus · brain_context · brain_read · brain_write · brain_capture
        </span>
      </footer>
      <BrandFoot />
    </div>
  );
}
