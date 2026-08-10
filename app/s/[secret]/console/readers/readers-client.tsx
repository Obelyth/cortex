"use client";
import { Reveal } from "../reveal";
import styles from "../console.module.css";

/**
 * The readers screen is an instrument again.
 *
 * It accreted controls — default picker, provider switches, guest policy — until it was half
 * dashboard, half control panel, and a first-time operator could not tell which. The controls
 * moved to the settings screen, their one home. What remains is what this screen was for: each
 * reader's record on the live corpus, the eval states, and who is reading right now. The one
 * verb left is a link to where the verbs live.
 */

export interface ReaderVM {
  model: string;
  provider: string;
  configured: boolean;
  disabled: boolean;
  evalState: "measured" | "unstable" | "unmeasured";
  evalNote: string;
  isDefault: boolean;
  defaultSource: string | null;
  calls: number;
  verified: number;
  unverified: number;
  errors: number;
  p50: number | null;
}

export interface ProviderVM {
  provider: string;
  keyEnv: string;
  configured: boolean;
  disabled: boolean;
  models: number;
}

export function ReadersClient({
  readers,
  providers,
  conflicts,
  envReader,
  builtIn,
  usageNote,
}: {
  readers: ReaderVM[];
  providers: ProviderVM[];
  conflicts: string[];
  envReader: string | null;
  builtIn: string;
  usageNote: string;
}) {
  const maxCalls = Math.max(1, ...readers.map((r) => r.calls));

  return (
    <div className={styles.split}>
      <div className={styles.splitMain}>
        {conflicts.map((c) => (
          <div key={c} className={styles.refused}>{c}</div>
        ))}

        <section>
          <div className={styles.sectionHead}>
            <span className={styles.label}>Readers · last 24 hours</span>
            <span className={styles.note}>{usageNote}</span>
          </div>

          <div className={styles.rdHead}>
            <div>model</div>
            <div>eval</div>
            <div className={styles.right}>calls</div>
            <div>verdicts</div>
            <div className={styles.right}>p50</div>
            <div />
          </div>

          {readers.map((r) => (
            <div key={r.model} className={`${styles.rdRow}${r.isDefault ? " " + styles.rdOn : ""}`}>
              <div className={styles.rdModel}>
                <span className={styles.rdName}>{r.model}</span>
                <span className={styles.note}>
                  {r.provider}
                  {!r.configured && " · no key"}
                  {r.disabled && " · provider off"}
                  {r.isDefault && ` · default (${r.defaultSource})`}
                </span>
              </div>

              <div>
                <span
                  className={`${styles.rdBadge} ${
                    r.evalState === "measured"
                      ? styles.vPass
                      : r.evalState === "unstable"
                        ? styles.vFail
                        : styles.rdUnknown
                  }`}
                  title={r.evalNote}
                >
                  {r.evalState}
                </span>
                <span className={styles.rdEvalNote}>{r.evalNote}</span>
              </div>

              <div className={`${styles.right} ${styles.fig}`}>{r.calls || "·"}</div>

              <div className={styles.rdBar}>
                {r.calls === 0 ? (
                  <span className={styles.rdNone}>no calls</span>
                ) : (
                  <>
                    <span className={styles.rdTrack} style={{ width: `${(r.calls / maxCalls) * 100}%` }}>
                      <i className={styles.rdPass} style={{ flex: r.verified }} />
                      <i className={styles.rdFail} style={{ flex: r.unverified + r.errors }} />
                      <i className={styles.rdRest}
                        style={{ flex: Math.max(0, r.calls - r.verified - r.unverified - r.errors) }} />
                    </span>
                    <span className={styles.note}>
                      {r.verified} verified
                      {r.unverified > 0 && ` · ${r.unverified} unverified`}
                      {r.errors > 0 && ` · ${r.errors} error`}
                    </span>
                  </>
                )}
              </div>

              <div className={`${styles.right} ${styles.fig}`}>
                {r.p50 === null ? "·" : `${(r.p50 / 1000).toFixed(1)}s`}
              </div>

              <div className={styles.right}>
                {r.isDefault && <span className={styles.rdIsDefault}>reading</span>}
              </div>
            </div>
          ))}

          <div className={styles.footNote}>
            <span className="swatches">
              <span className="swatch"><i style={{ background: "var(--ok)" }} />verified</span>
              <span className="swatch"><i style={{ background: "var(--crit)" }} />failed</span>
              <span className="swatch"><i style={{ background: "var(--ob-ink-600)" }} />other</span>
            </span>{" "}
            <Reveal label="reading these bars">
              &ldquo;Other&rdquo; includes NOT IN BRAIN, which is an honest answer rather than a
              failure. Verdicts are this reader&rsquo;s own record on the live corpus, not the
              eval — and a reader with no calls has no record, which is different from a bad one.
            </Reveal>
          </div>
        </section>
      </div>

      <div className={styles.rail}>
        <section>
          <div className={styles.label}>Providers</div>
          {providers.map((p) => (
            <div key={p.provider} className={styles.pvRow}>
              <span className={p.disabled ? styles.dotIdle : p.configured ? styles.dotLive : styles.dotWarn} />
              <span className={styles.doorName}>
                <span>{p.provider}</span>
                <span className={styles.note}>
                  {p.configured ? `${p.keyEnv} set` : `${p.keyEnv} missing`} · {p.models} models
                  {p.disabled && " · off"}
                </span>
              </span>
            </div>
          ))}
          <div className={styles.railNote}>
            The default reader and the provider switches live in{" "}
            <a className={styles.railLink} href="settings">settings</a> — this screen only
            reports.
          </div>
        </section>

        <section>
          <div className={styles.label}>How the reader is chosen</div>
          <ol className={styles.rdChain}>
            <li>
              <span>the call&rsquo;s own <code>model</code> argument</span>
              <span className={styles.note}>per ask, must be on the allowlist</span>
            </li>
            <li>
              <span>the settings screen&rsquo;s default</span>
              <span className={styles.note}>the console&rsquo;s one control surface</span>
            </li>
            <li>
              <span>READER_MODEL</span>
              <span className={styles.note}>{envReader ? `set to ${envReader}` : "not set"}</span>
            </li>
            <li>
              <span>the built-in default</span>
              <span className={styles.note}>{builtIn}</span>
            </li>
          </ol>
        </section>
      </div>
    </div>
  );
}
