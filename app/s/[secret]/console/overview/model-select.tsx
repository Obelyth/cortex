"use client";
import { useReaderSave } from "../use-reader-save";

/**
 * The design's ANSWERING MODEL control, rendered by the models table. A native <select> in an
 * ink well — the design uses the platform control, so this does too. Keyless models stay listed
 * the way the design lists them ("· no key"), but cannot be picked: a menu that lets you choose
 * a reader that will error is a trap, not a control. The write rides the same gated
 * settings/save route as every other reader control, through the one shared hook.
 */
export function ModelSelect({
  options,
  current,
  writable,
}: Readonly<{
  options: Array<{ model: string; configured: boolean }>;
  current: string;
  writable: boolean;
}>) {
  const { pending, error, save } = useReaderSave();

  return (
    <>
      <select
        className="modelSelect"
        value={current}
        disabled={!writable}
        aria-busy={pending}
        aria-describedby={error ? "model-select-err" : undefined}
        aria-label="Answering model"
        title={writable ? "which model answers brain_ask" : "no settings store — set READER_MODEL in the environment"}
        onChange={(e) => { if (!pending && e.target.value !== current) void save(e.target.value); }}
      >
        {current === "" && <option value="">UNRESOLVED</option>}
        {options.map((o) => (
          <option key={o.model} value={o.model} disabled={!o.configured}>
            {o.model.toUpperCase()}
            {o.configured ? "" : " · NO KEY"}
          </option>
        ))}
      </select>
      {/* Present before it has anything to say — see reader-select.tsx. */}
      <span id="model-select-err" className="modelSelectErr" role="status">{error}</span>
    </>
  );
}
