"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import styles from "../console.module.css";

/**
 * The two controls, and the honesty around them.
 *
 * Writes go to a route handler under this same secret path, reached with a path derived from
 * window.location — so the secret rides the request without ever being rendered into markup or
 * closed over in a bundle. A refused write is shown verbatim: the server owns which
 * combinations are legal, and a client that guessed at them would eventually disagree with it.
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
  holdsDefault: boolean;
}

export interface GuestVM {
  /** Whether GUEST_PATH_SECRET is set at all. Presence only — never the value. */
  open: boolean;
  scope: string[];
  citations: boolean;
  dailyAsks: number;
  maxK: number;
  usedToday: number | null;
  reader: string;
}

/** The areas a scope can name. Ordered by how much damage each does if shared. */
const AREAS = [
  { path: "projects/", label: "projects/", note: "project pages" },
  { path: "notes/", label: "notes/", note: "reference notes" },
  { path: "archive/", label: "archive/", note: "old material" },
  { path: "log/", label: "log/", note: "daily logs" },
  { path: "profile.md", label: "profile.md", note: "who you are" },
];

/** The pathname of the write endpoint, derived rather than rendered. */
function settingsUrl(): string {
  const p = window.location.pathname.replace(/\/+$/, "");
  return `${p.replace(/\/readers$/, "")}/settings`;
}

export function ReadersClient({
  readers,
  providers,
  guest,
  writable,
  storeNote,
  conflicts,
  envReader,
  builtIn,
  usageNote,
}: {
  readers: ReaderVM[];
  providers: ProviderVM[];
  guest: GuestVM;
  writable: boolean;
  storeNote: string | null;
  conflicts: string[];
  envReader: string | null;
  builtIn: string;
  usageNote: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(patch: Record<string, unknown>, tag: string) {
    setBusy(tag);
    setError(null);
    try {
      const res = await fetch(settingsUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `the write was refused (${res.status})`);
        return;
      }
      // Re-render from the server rather than patching local state: the screen's job is to show
      // what the read path will actually do, and only the server knows that.
      start(() => router.refresh());
    } catch {
      setError("the write did not reach the server");
    } finally {
      setBusy(null);
    }
  }

  const working = pending || busy !== null;
  const maxCalls = Math.max(1, ...readers.map((r) => r.calls));

  return (
    <div className={styles.split}>
      <div className={styles.splitMain}>
        {error && <div className={styles.refused}>{error}</div>}
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

          {readers.map((r) => {
            const off = r.disabled || !r.configured;
            return (
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
                  {r.isDefault ? (
                    <span className={styles.rdIsDefault}>reading</span>
                  ) : (
                    <button
                      type="button"
                      className={styles.rdBtn}
                      disabled={!writable || working || off}
                      title={
                        !writable
                          ? "the settings store is not writable — see the note in the rail"
                          : !r.configured
                            ? `${r.provider} has no API key, so this reader would error on call`
                            : r.disabled
                              ? `${r.provider} is switched off`
                              : `read the brain with ${r.model}`
                      }
                      onClick={() => send({ defaultReader: r.model }, r.model)}
                    >
                      {busy === r.model ? "…" : "make default"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          <div className={styles.footNote}>
            Green is verified, red is unverified or an error, steel is every other verdict —
            NOT IN BRAIN among them, which is an honest answer rather than a failure. Verdicts
            are this reader&rsquo;s own record on the live corpus, not the eval: a reader with no
            calls has no record, which is different from a bad one.
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
                </span>
              </span>
              <button
                type="button"
                className={`${styles.pvBtn}${p.disabled ? "" : " " + styles.pvOn}`}
                disabled={!writable || working || p.holdsDefault}
                aria-pressed={!p.disabled}
                title={
                  p.holdsDefault
                    ? "this provider serves the current default reader — change the default first"
                    : p.disabled
                      ? `let callers select ${p.provider} models again`
                      : `stop any call selecting ${p.provider} models`
                }
                onClick={() =>
                  send(
                    {
                      disabledProviders: p.disabled
                        ? providers.filter((x) => x.disabled && x.provider !== p.provider).map((x) => x.provider)
                        : [...providers.filter((x) => x.disabled).map((x) => x.provider), p.provider],
                    },
                    p.provider
                  )
                }
              >
                {busy === p.provider ? "…" : p.disabled ? "off" : "on"}
              </button>
            </div>
          ))}
          <div className={styles.railNote}>
            A switch controls <b>selection</b>, not the key. Turning a provider off stops any
            call choosing its models; it does not revoke a credential, and it can never leave
            brain_ask with no reader — the last resort of the fallback chain ignores these
            switches by design.
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
              <span>this console&rsquo;s default</span>
              <span className={styles.note}>{writable ? "settable here" : "unavailable — no store"}</span>
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
          {storeNote && <div className={styles.railNote}>{storeNote}</div>}
        </section>

        <section>
          <div className={styles.sectionHead}>
            <span className={styles.label}>
              Guest access {guest.open ? "" : "· door closed"}
            </span>
            {/* This screen scopes the guest door; the guide is where its URL shape lives. */}
            <a className={styles.railLink} href="guide">the door</a>
          </div>
          {!guest.open ? (
            <div className={styles.railNote}>
              No <span className={styles.mono}>GUEST_PATH_SECRET</span> is set, so the guest door
              does not exist and these settings apply to nobody. Set one — different from the
              connector secret — to hand an assistant you do not control a way in.
            </div>
          ) : (
            <div className={styles.railNote}>
              A guest asks questions; it never receives notes. {guest.reader} reads the brain and
              returns an answer drawn only from the areas ticked below.
            </div>
          )}

          <div className={styles.gScope}>
            {AREAS.map((a) => {
              const on = guest.scope.includes(a.path);
              return (
                <button
                  key={a.path}
                  type="button"
                  className={`${styles.gArea}${on ? " " + styles.gOn : ""}`}
                  disabled={!writable || working}
                  aria-pressed={on}
                  title={
                    on
                      ? `stop guests drawing answers from ${a.path}`
                      : `let guests draw answers from ${a.path} — ${a.note}`
                  }
                  onClick={() =>
                    send(
                      {
                        guest: {
                          scope: on
                            ? guest.scope.filter((s) => s !== a.path)
                            : [...guest.scope, a.path],
                        },
                      },
                      `scope:${a.path}`
                    )
                  }
                >
                  {busy === `scope:${a.path}` ? "…" : a.label}
                </button>
              );
            })}
          </div>

          <div className={styles.gRow}>
            <span className={styles.note}>show source and evidence</span>
            <button
              type="button"
              className={`${styles.pvBtn}${guest.citations ? " " + styles.pvOn : ""}`}
              disabled={!writable || working}
              aria-pressed={guest.citations}
              title={
                guest.citations
                  ? "stop returning note paths and verbatim excerpts to guests"
                  : "return the source path and the verbatim quote to guests too"
              }
              onClick={() => send({ guest: { citations: !guest.citations } }, "citations")}
            >
              {busy === "citations" ? "…" : guest.citations ? "on" : "off"}
            </button>
          </div>

          <div className={styles.gRow}>
            <span className={styles.note}>asks today</span>
            <span className={styles.fig}>
              {guest.usedToday === null ? "—" : guest.usedToday} / {guest.dailyAsks}
            </span>
          </div>

          <div className={styles.railNote}>
            Scope is applied by removing notes from the corpus <b>before</b> the reader runs, so
            an unticked area cannot be quoted, summarised or talked around. The budget resets at
            00:00 UTC.
          </div>
        </section>

        <section>
          <div className={styles.label}>Keys</div>
          <div className={styles.railNote}>
            API keys are environment variables and are never entered, stored or displayed here —
            the console reports only whether each one is present. Add or rotate them where the
            deployment&rsquo;s environment lives.
          </div>
        </section>
      </div>
    </div>
  );
}
