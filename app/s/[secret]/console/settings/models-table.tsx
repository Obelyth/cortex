"use client";
import { useState } from "react";
import { ModelSelect } from "../overview/model-select";
import styles from "../console.module.css";

/**
 * The models list — iOS-shaped on the owner's call: one summary line per model, the whole
 * per-model record folded behind its caret. The single picker is the ANSWERING MODEL select in
 * the header (the same control the overview carries); rows carry no verbs. Same honesty as the
 * table this replaces: eval states never borrow credibility, a reader with no calls has no
 * record, and every count names its window.
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

function evalChip(r: ReaderVM): { cls: string; text: string } {
  if (r.evalState === "measured") return { cls: " mdlChipPass", text: r.evalNote.split(" ")[0] };
  if (r.evalState === "unstable") return { cls: " mdlChipWarn", text: "shaky" };
  return { cls: "", text: "not yet" };
}

function rowSub(r: ReaderVM): string {
  const bits = [r.provider];
  if (!r.configured) bits.push("no key");
  if (r.disabled) bits.push("provider off");
  if (r.isDefault) bits.push(`answering (${r.defaultSource})`);
  bits.push(r.calls ? `${r.calls} asks` : "no asks");
  return bits.join(" · ");
}

export function ModelsTable({
  readers,
  usageNote,
  writable,
}: Readonly<{ readers: ReaderVM[]; usageNote: string; writable: boolean }>) {
  const [open, setOpen] = useState<string | null>(null);
  const current = readers.find((r) => r.isDefault)?.model ?? "";
  const options = readers
    .filter((r) => !r.disabled)
    .map((r) => ({ model: r.model, configured: r.configured }));

  return (
    <section className="card">
      <div className={styles.sectionHead}>
        <span className={styles.label}>
          Models <span className="labelNote">{usageNote}</span>
        </span>
        <span className="swatches">
          <span className={styles.label}>answering model</span>
          <ModelSelect options={options} current={current} writable={writable} />
        </span>
      </div>

      {readers.map((r) => {
        const chip = evalChip(r);
        const on = open === r.model;
        const scored = r.verified + r.unverified + r.errors;
        return (
          <div key={r.model} className="mdlRow" style={{ opacity: r.configured ? 1 : 0.55 }}>
            <button
              type="button"
              className="mdlSum"
              aria-expanded={on}
              onClick={() => setOpen(on ? null : r.model)}
            >
              <span className="mdlCaret">▶</span>
              <span className={`mdlName${r.isDefault ? " mdlNameOn" : ""}`}>{r.model}</span>
              <span className="mdlSub">{rowSub(r)}</span>
              <span className={`mdlChip${chip.cls}`} title={r.evalNote}>{chip.text}</span>
            </button>
            {on && (
              <div className="mdlDetail">
                <div className={styles.note}>tested: {r.evalNote}</div>
                {r.calls > 0 ? (
                  <>
                    <div className={styles.rdBar}>
                      <span className={styles.rdTrack} style={{ width: "100%", maxWidth: 260 }}>
                        <i className={styles.rdPass} style={{ flex: r.verified }} />
                        <i className={styles.rdFail} style={{ flex: r.unverified + r.errors }} />
                        <i className={styles.rdRest} style={{ flex: Math.max(0, r.calls - scored) }} />
                      </span>
                      <span className={styles.note}>
                        {r.verified} right
                        {r.unverified > 0 && ` · ${r.unverified} wrong`}
                        {r.errors > 0 && ` · ${r.errors} error${r.errors === 1 ? "" : "s"}`}
                        {r.p50 !== null && ` · p50 ${(r.p50 / 1000).toFixed(1)}s`}
                      </span>
                    </div>
                  </>
                ) : (
                  <div className={styles.note}>no asks in the window — no record to show</div>
                )}
                <div className={styles.note}>
                  eval it yourself: <span className={styles.mono}>npx tsx scripts/eval.ts --model {r.model}</span>
                  {" "}· 185 questions · ~10 min
                </div>
              </div>
            )}
          </div>
        );
      })}

      <div className={styles.footNote}>
        keyless models stay listed — a key in the environment lights them · plain reads never touch a model
      </div>
    </section>
  );
}
