"use client";
import { Reveal } from "../reveal";

/**
 * The pin control — the heat view's one mutation, in its two sizes.
 *
 * One component for every surface that offers a pin (a heat tile, a band row, the ledger
 * expansion) so there is exactly one rendering of "what a pin is": the operator's judgement,
 * recorded in note_pins, outranking the computed temperature until removed. State and the
 * gated POST live in the corpus screen; this only shows and asks.
 *
 * Two moves, not three: pin HOT ("keep this in the seat") and pin COLD ("this looks busy, it
 * is noise") are the two judgements the temperature migration names. note_pins accepts warm
 * too, but a control is a sentence and warm is not one anyone has needed to say yet.
 */

export interface PinState {
  temperature: "hot" | "warm" | "cold";
  reason: string;
}

export function PinControl({
  path,
  pin,
  available,
  busy,
  onPin,
}: Readonly<{
  path: string;
  pin: PinState | null;
  /** False when note_pins cannot be read or written — the control then says why instead of
   *  rendering buttons over a store that is not there. */
  available: boolean;
  busy: boolean;
  onPin: (path: string, temperature: "hot" | "cold" | null) => void;
}>) {
  if (!available) {
    return (
      <div className="htPinRow">
        <span className="htPinLabel">pin</span>
        <span className="htPinNone">
          unavailable — note_pins could not be reached, so nothing can be pinned or unpinned from here
        </span>
      </div>
    );
  }
  return (
    <div className="htPinRow">
      <span className="htPinLabel">pin</span>
      {pin ? (
        <>
          <span className={`htPinState htPin-${pin.temperature}`}>
            pinned {pin.temperature}
            {pin.reason ? ` — “${pin.reason}”` : ""}
          </span>
          <button type="button" className="htPinBtn" disabled={busy} onClick={() => onPin(path, null)}>
            unpin
          </button>
          <span className="htPinNote">unpinning restores the computed temperature exactly</span>
        </>
      ) : (
        <>
          <button type="button" className="htPinBtn" disabled={busy} onClick={() => onPin(path, "hot")}>
            pin hot
          </button>
          <button type="button" className="htPinBtn" disabled={busy} onClick={() => onPin(path, "cold")}>
            pin cold
          </button>
          <span className="htPinNote">
            <Reveal label="what a pin does">
              a pin outranks the computed score until removed — hot keeps it in the seat and rides
              handoff bundles cited “pinned”; cold keeps it out
            </Reveal>
          </span>
        </>
      )}
    </div>
  );
}
