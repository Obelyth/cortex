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

      <h2>Wire Cursor <span className="count">read · write</span></h2>
      <p className="lede">
        Same bearer door as Claude Code. Add this to{" "}
        <span className="mono">~/.cursor/mcp.json</span> (or a project{" "}
        <span className="mono">.cursor/mcp.json</span>), then refresh MCP in Settings → Tools
        &amp; MCP. All six tools are available — prefer{" "}
        <span className="mono">brain_corpus</span> for reads (no Anthropic key);{" "}
        <span className="mono">brain_write</span> / <span className="mono">brain_capture</span>{" "}
        for commits.
      </p>
      <pre>{`{
  "mcpServers": {
    "cortex": {
      "url": "https://<host>/api/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_TOKEN>"
      }
    }
  }
}`}</pre>

      <h2>Wire Gemini / Codex <span className="count">header-capable CLIs</span></h2>
      <p className="lede">
        Point each client&rsquo;s MCP HTTP config at{" "}
        <span className="mono">https://&lt;host&gt;/api/mcp</span> with{" "}
        <span className="mono">Authorization: Bearer &lt;MCP_TOKEN&gt;</span> — same endpoint as
        Cursor and Claude Code, in that client&rsquo;s own syntax.
      </p>

      <h2>Wire claude.ai / ChatGPT <span className="count">header-less connectors</span></h2>
      <p className="lede">
        Clients that cannot send headers use the secret-URL alias
        instead: <span className="mono">/api/s/&lt;secret&gt;/mcp</span>. Add it once as a custom
        connector on the web (claude.ai syncs to iOS and desktop). The secret
        lives only in that URL and in the server&rsquo;s environment.
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
        Prefer <span className="mono">brain_corpus</span> so the calling model reads the notes
        directly. When you want a stamp, <span className="mono">brain_ask</span> cites the file it
        answered from and a deterministic verifier — no model, no network — checks the quote
        against that file at that commit. A passage the brain has retracted (marked{" "}
        <span className="mono">SUPERSEDED</span>, <span className="mono">CORRECTION</span>,{" "}
        <span className="mono">DEPRECATED</span>, <span className="mono">(was: &quot;…&quot;)</span>{" "}
        or <span className="mono">Do not answer</span>) comes back stamped SUPERSEDED rather than
        VERIFIED — verbatim is exactly what a stale answer looks like in a memory that keeps its
        corrections on the page.
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
