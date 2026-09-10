"use client";
import { useState } from "react";
import { useLens } from "../lens";
import { useWrites } from "./settings-client";
import { settingsEndpoint } from "./endpoints";

/**
 * Readers · the record — one row per allowlisted model under the answering-model control, and
 * the reader lens (L11) a row opens: its eval, its asks in the window, "Make default".
 *
 * Same honesty as the table this restates: an eval state never borrows credibility from the
 * list it sits in, a reader with no calls has no record, cached rows are outside the record
 * (modelRecordRows), and every count names its window. "Make default" is the one verb, and it
 * writes {defaultReader} through the same gated route as the select above it.
 */

export interface ReaderAsk {
  ts: number;
  ms: number;
  stamp: string;
  surface: string;
}

export interface ReaderRow {
  model: string;
  provider: string;
  keyEnv: string;
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
  /** Its asks in the window, newest first, capped by the page. */
  asks: ReaderAsk[];
}

function evalChip(r: ReaderRow): { cls: string; text: string } {
  if (r.evalState === "measured") return { cls: "setRecEval setRecEvalOk", text: r.evalNote.split(" ")[0] };
  if (r.evalState === "unstable") return { cls: "setRecEval setRecEvalWarn", text: "shaky" };
  return { cls: "setRecEval", text: "not yet" };
}

const keyWord = (r: ReaderRow) => `${r.provider} · ${r.configured ? "key set" : `${r.keyEnv} missing`}${r.disabled ? " · provider off" : ""}`;
const hhmm = (ts: number) => new Date(ts).toISOString().slice(11, 16);

export function ReadersRecord({ readers, note, writable }: Readonly<{ readers: ReaderRow[]; note: string; writable: boolean }>) {
  const lens = useLens();
  const w = useWrites();
  const open = (r: ReaderRow) =>
    lens.open({
      kind: "reader",
      title: r.model,
      body: (
        <ReaderLens
          r={r}
          writable={writable}
          makeDefault={() => w.post(settingsEndpoint("save"), { defaultReader: r.model }, "defaultReader")}
        />
      ),
    });

  return (
    <div className="setRec">
      <div className="setRecHead">
        <h3 className="setEyebrow">Readers · the record</h3>
        <span className="setRecNote">{note}</span>
      </div>
      <div className="setRecCols" aria-hidden>
        <span>Model</span>
        <span>Eval</span>
        <span>ok / bad / err</span>
        <span>p50</span>
      </div>
      {readers.map((r) => {
        const chip = evalChip(r);
        return (
          <button key={r.model} type="button" className="setRecRow" onClick={() => open(r)} aria-label={`${r.model} — open in the lens`}>
            <span>
              <span className="setRecModel">
                {r.model}
                {r.isDefault && <span className="setRecDefault"> · default</span>}
              </span>
              <span className="setRecSub">{keyWord(r)}</span>
            </span>
            <span className={chip.cls} title={r.evalNote}>{chip.text}</span>
            <span className="setRecNum">{r.calls ? `${r.verified} / ${r.unverified} / ${r.errors}` : "—"}</span>
            <span className="setRecNum">{r.p50 !== null ? `${(r.p50 / 1000).toFixed(1)}s` : "—"}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The lens body for one reader (L11). Its own busy state, because the body is a snapshot the
 *  lens holds — on an accepted write the lens closes and the refreshed sheet shows the new
 *  default; on a refusal the server's sentence stays in view here. */
function ReaderLens({
  r,
  writable,
  makeDefault,
}: Readonly<{ r: ReaderRow; writable: boolean; makeDefault: () => Promise<{ ok: true } | { ok: false; error: string }> }>) {
  const lens = useLens();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const can = writable && !r.isDefault && r.configured && !r.disabled;
  const why = !writable
    ? "no settings store to write to"
    : r.isDefault
      ? "already the default"
      : !r.configured
        ? `${r.keyEnv} is not set — a default that errors on call is a trap`
        : r.disabled
          ? `${r.provider} is switched off — turn it on first`
          : undefined;

  async function go() {
    setBusy(true);
    setErr(null);
    const res = await makeDefault();
    setBusy(false);
    if (res.ok) lens.close();
    else setErr(res.error);
  }

  return (
    <>
      <div>
        <span className={r.isDefault ? "setLensTag setLensTagOn" : "setLensTag"}>reader</span>
        <div className="setLensId">
          {keyWord(r)}
          {r.isDefault ? ` · default (${r.defaultSource})` : ""}
        </div>
      </div>
      <p className="setLensDesc">{r.evalNote}</p>
      <dl className="setLensKv">
        <dt className="setLensK">eval</dt>
        <dd className="setLensV">{r.evalState}</dd>
        <dt className="setLensK">asks · 24 h</dt>
        <dd className="setLensV">{r.calls}</dd>
        <dt className="setLensK">verified</dt>
        <dd className="setLensV">{r.verified}</dd>
        <dt className="setLensK">unverified</dt>
        <dd className="setLensV">{r.unverified}</dd>
        <dt className="setLensK">errors</dt>
        <dd className="setLensV">{r.errors}</dd>
        <dt className="setLensK">p50 latency</dt>
        <dd className="setLensV">{r.p50 !== null ? `${(r.p50 / 1000).toFixed(1)} s` : "—"}</dd>
      </dl>
      <div>
        <div className="setLensTies">Its asks · newest first</div>
        {r.asks.length === 0 ? (
          <div className="setLensEmpty">no asks in the window — no record to show</div>
        ) : (
          r.asks.map((a, i) => (
            <div key={`${a.ts}-${i}`} className="setLensTie">
              <span className="setLensTieKind">{a.stamp}</span>
              <span>
                <span className="setLensTieLabel">{hhmm(a.ts)} utc · {(a.ms / 1000).toFixed(1)} s</span>
                <span className="setLensTieWhy">{a.surface}</span>
              </span>
            </div>
          ))
        )}
      </div>
      <div className="setLensActions">
        <button type="button" className="setLensBtn setLensBtnPrimary" disabled={!can || busy} title={why} onClick={() => void go()}>
          {busy ? "…" : "Make default"}
        </button>
      </div>
      {err && <div className="setRefused" role="alert">{err}</div>}
      <div className="setLensNote">
        the default follows the measurement, not the logo — a reader takes the chair by beating the labelled eval · eval it
        yourself: npx tsx scripts/eval.ts --model {r.model} · 185 questions · ~10 min
      </div>
    </>
  );
}
