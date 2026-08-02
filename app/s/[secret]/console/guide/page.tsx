import { requireSecret } from "@/lib/gate";
import styles from "../console.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Guide · Cortex console" };

/** Guide — wire-up on the left, reference on the right. Fetches nothing, but gates like its siblings so the invariant stays uniform. */
export default async function Guide({
  params,
}: {
  params: Promise<{ secret: string }>;
}) {
  await requireSecret(params);
  return (
    <div className={styles.twoCol}>
      <section className={styles.block}>
        <div className={styles.blockHead}><span>1 · Terminal</span></div>
        <pre className={styles.pre}>{`claude mcp add --transport http cortex \\
  https://<host>/api/mcp \\
  --header "Authorization: Bearer <MCP_TOKEN>"`}</pre>
        <div className={styles.blockHead}><span>2 · claude.ai</span></div>
        <p className={styles.prose}>
          Custom connectors cannot send headers, so they use the secret-URL alias{" "}
          <span className={styles.mono}>/api/s/&lt;secret&gt;/mcp</span>. Add it once on the web
          and it syncs to iOS and desktop on its own.
        </p>
        <div className={styles.blockHead}><span>3 · The rituals</span></div>
        <p className={styles.prose}>
          <b>Boot</b> — open with brain_context. <b>Capture</b> — &ldquo;remember: …&rdquo;
          becomes a commit. <b>Wrap up</b> — outcomes to project pages and the daily log.
        </p>
      </section>
      <section className={styles.block}>
        <div className={styles.blockHead}><span>The six tools</span></div>
        {[
          ["brain_ask", "reads the whole corpus, cites, and the verifier stamps the citation"],
          ["brain_corpus", "hands the notes to the calling model instead — no egress"],
          ["brain_context", "profile · index · the last week of logs, one call"],
          ["brain_read", "one note by path"],
          ["brain_write", "create, replace, append — returns the commit SHA"],
          ["brain_capture", "timestamped append to today's log, from any device"],
        ].map(([name, what]) => (
          <div key={name} className={styles.toolRow}>
            <span className={styles.mono}>{name}</span>
            <span className={styles.toolWhat}>{what}</span>
          </div>
        ))}
        <div className={styles.footNote}>
          full reference on the public site: /tools · /guide · /map
        </div>
      </section>
    </div>
  );
}
