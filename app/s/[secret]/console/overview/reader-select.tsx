"use client";
import { useReaderSave } from "../use-reader-save";

/**
 * The reader (W09 → S1): which model answers brain_ask. A native <select> in a trough — v2 uses
 * the platform control, so this does too. Keyless models stay listed the way the design lists
 * them ("· key missing"), but cannot be picked: a menu that lets you choose a reader that will
 * error is a trap, not a control. The write rides the console's one gated settings/save route as
 * {defaultReader}, through the shared hook every reader control uses, so a failed save says so
 * here instead of leaving the old model on screen in silence.
 */
export function ReaderSelect({ options, current, writable }: Readonly<{
  options: Array<{ id: string; label: string; disabled: boolean }>;
  current: string;
  writable: boolean;
}>) {
  const { pending, error, save } = useReaderSave();

  return (
    <>
      <select
        id="ov-reader"
        className="ovReader"
        value={current}
        disabled={!writable}
        aria-busy={pending}
        aria-describedby={error ? "ov-reader-err" : undefined}
        title={writable ? "which model answers brain_ask" : "no settings store — set READER_MODEL in the environment"}
        onChange={(e) => { if (!pending && e.target.value !== current) void save(e.target.value); }}
      >
        {current === "" && <option value="">unresolved</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id} disabled={o.disabled}>{o.label}</option>
        ))}
      </select>
      {/* Present before it has anything to say: a live region inserted together with its text
          is not reliably announced. */}
      <span id="ov-reader-err" className="ovReaderErr" role="status">{error}</span>
    </>
  );
}
