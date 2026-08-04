import { BrandFoot, Mast } from "../mast";

/**
 * How the system is wired and used, written public-safe: mechanisms are described, secrets are
 * placeholders, and nothing here names the private repo or any note.
 */
export default function Guide() {
  return (
    <div className="wrap">
      <Mast active="/guide" />

      <h2>Wire a terminal <span className="count">Claude Code, any machine</span></h2>
      <p className="lede">
        One command, user scope, and every project on the machine can reach the brain. The token
        is the bearer <span className="mono">MCP_TOKEN</span>; it never appears in a URL.
      </p>
      <pre>{`claude mcp add --transport http cortex \\
  https://<host>/api/mcp \\
  --header "Authorization: Bearer <MCP_TOKEN>"`}</pre>

      <h2>Wire claude.ai <span className="count">web · iOS · desktop</span></h2>
      <p className="lede">
        claude.ai custom connectors cannot send headers, so they use the secret-URL alias
        instead: <span className="mono">/api/s/&lt;secret&gt;/mcp</span>. Add it once as a custom
        connector on the web, and it syncs to the iOS app and desktop on its own. The secret
        lives only in that URL and in the server's environment.
      </p>

      <h2>Open a guest door <span className="count">off by default</span></h2>
      <p className="lede">
        Set <span className="mono">GUEST_PATH_SECRET</span> and a third path exists:{" "}
        <span className="mono">/api/g/&lt;secret&gt;/mcp</span>. A guest can ask — scoped to the
        areas you share, never handed the corpus — and propose a note for your review; accepting
        is what commits. Nothing else is registered on that door, so nothing else appears to
        exist.
      </p>

      <h2>The rituals</h2>
      <div className="panel">
        <div className="ritual">
          <span className="pill n">BOOT</span>
          <div>
            A session that needs context opens with{" "}
            <span className="mono">brain_context</span> — profile, index, and the last week of
            log entries, one call.
          </div>
        </div>
        <div className="ritual">
          <span className="pill n">CAPTURE</span>
          <div>
            &ldquo;Remember: …&rdquo; from any device becomes{" "}
            <span className="mono">brain_capture</span> — a timestamped entry in today&rsquo;s
            log, committed. A save is only real if a commit SHA came back.
          </div>
        </div>
        <div className="ritual">
          <span className="pill n">WRAP UP</span>
          <div>
            At session end, outcomes go to the relevant project page and the daily log — the
            same ritual on desktop and phone, the same files.
          </div>
        </div>
      </div>

      <h2>How answers are proven</h2>
      <p className="lede">
        <span className="mono">brain_ask</span> reads the whole live corpus and cites the file it
        answered from. A deterministic verifier — no model, no network — then checks the quote
        against that file at that commit, and the stamp says exactly what that proves. A passage
        the brain has retracted (marked <span className="mono">SUPERSEDED</span>,{" "}
        <span className="mono">CORRECTION</span>, <span className="mono">DEPRECATED</span>,{" "}
        <span className="mono">(was: &quot;…&quot;)</span> or{" "}
        <span className="mono">Do not answer</span>) comes back stamped SUPERSEDED rather than
        VERIFIED — verbatim is exactly what a stale answer looks like in a memory that keeps its
        corrections on the page. Quote the current claim beside its own{" "}
        <span className="mono">(was: &quot;…&quot;)</span> marker and the stamp is{" "}
        <span className="mono">CORRECTED</span> instead: the correction was made in place, so
        answer from the current claim.
      </p>

      <h2>What is public and what is not</h2>
      <p className="lede">
        This site&rsquo;s split is a privacy boundary, not a design one. The overview, this
        guide, the tools reference and the <a href="/map">demo map</a> are public and carry
        nothing real — the demo map is the true renderer over synthetic placeholders. The live
        map and the console quote the actual brain, so they live behind the connector
        secret and answer an empty 404 to anyone else.
      </p>

      <footer className="foot">
        Boot. Capture. Wrap up. — the whole practice, three calls.
      </footer>
      <BrandFoot />
    </div>
  );
}
