import type { ReactNode } from "react";
import type { Ground } from "../ground";
import { GroundSwitch } from "./ground-switch";
import { GuestRows, ReaderRows, RefusedLine, SavedLine, SettingsWrites, type SettingsVM } from "./settings-client";
import { LearningRows, type LearningVM } from "./learning-client";
import { ReadersRecord, type ReaderRow } from "./readers-panel";
import { ConnectSection } from "./connect-section";
import { Row, Val } from "./rows";
import { DoorFold } from "./door-fold";
import { ConfigurationPanel, type ConfigurationView } from "./configuration-panel";
import type { OperationsReadiness } from "@/lib/console-operations-contract";
import { OperationsReadinessPanel } from "./operations-readiness";

/**
 * The Settings screen (v2), as one server composition over the view models the page loads —
 * page.tsx renders it live, scripts/dev/render-settings.tsx renders it from fixtures on both
 * grounds. The band carries the headline, the saved line and the store chip; then one group
 * per decision, first the ground (this device), then the reader, the guest door, the learning
 * knobs and the doors. Explanation lives one caret down, at the foot.
 *
 * Two laws, inherited and absolute:
 *   WRITE-ONLY VALUES. Approved capability forms accept complete groups, but never display,
 *   persist in Cortex, or read back those values. Env rows remain presence-only.
 *   THE STORE IS NOT THE AUTHORITY. Controls write to KV; when KV is absent or unreachable the
 *   chip says so, each panel holds and states its mode, and the sheet shows what the
 *   deployment falls back to rather than pretending.
 */

/** One row of the Doors group: presence (set / not set) or, for the two addresses, a value. */
export interface DoorRow {
  label: string;
  sub: string;
  set: boolean | null;
  value?: string;
}

export interface SettingsScreenProps {
  ground: Ground;
  vm: SettingsVM;
  modelOptions: { model: string; configured: boolean }[];
  activeModel: string;
  learning: LearningVM;
  readers: ReaderRow[];
  readersNote: string;
  doors: DoorRow[];
  /** Optional so the checked-in static fixture can lag without breaking the reviewed shell. */
  configuration?: ConfigurationView;
  /** Optional for unrelated fixtures; the authenticated live page always supplies this view. */
  operations?: OperationsReadiness;
  connect: {
    guestOpen: boolean;
    guestMissing?: string[];
    guestStoreState?: "store" | "unconfigured" | "unreachable";
    bearerSet: boolean;
    activeModel: string | null;
    activeSource: string | null;
    guestReader: string;
  };
  /** Store-parse and env conflicts, verbatim, from every family. */
  conflicts: string[];
}

function Group({ n, id, label, lede, children }: Readonly<{ n: string; id: string; label: string; lede: string; children: ReactNode }>) {
  return (
    <section className="setGroup" id={id} aria-labelledby={`${id}-h`} data-cx="rise">
      <div className="setGroupHead">
        <h2 className="setEyebrow" id={`${id}-h`}>{label}</h2>
        <p className="setLede">{lede}</p>
        <div className="setN" aria-hidden>{n}</div>
      </div>
      <div className="setPanel">{children}</div>
    </section>
  );
}

export function SettingsScreen(p: Readonly<SettingsScreenProps>) {
  return (
    <SettingsWrites>
      <div className="setRoot">
        <div className="setMast">
          <div className="setMastIn">
            <div className="setMastText">
              <h1 className="setTitle">
                What this deployment <b>should do.</b>
              </h1>
              <div className="setSubline">
                Preferences save as you change them. Service credentials need a separate deployment. · <SavedLine />
              </div>
            </div>
            {p.vm.storeState === "store" ? (
              <span className="setStore setStoreOn" role="status">preference saving available</span>
            ) : p.vm.storeState === "unconfigured" ? (
              <span className="setStore setStoreHeld" role="status">preference store not connected</span>
            ) : (
              <span className="setStore setStoreHeld" role="status">preference saving unavailable</span>
            )}
          </div>
        </div>

        <div className="setSheet">
          <RefusedLine />
          {p.conflicts.map((c) => (
            <div key={c} className="setRefused">{c}</div>
          ))}

          <Group n="01" id="setGround" label="Appearance" lede="Choose dark (Ink) or light (Paper) for this browser. This preference is saved on this device only.">
            <GroundSwitch ground={p.ground} />
          </Group>

          <Group n="02" id="setReader" label="Answering model" lede="Choose the model used for trusted questions. Provider switches change which models can be selected; they do not revoke API access, and fallback can still use a switched-off provider. Guests always use a Claude reader.">
            <ReaderRows vm={p.vm} modelOptions={p.modelOptions} activeModel={p.activeModel} />
            <ReadersRecord readers={p.readers} note={p.readersNote} writable={p.vm.writable} />
          </Group>

          <Group n="03" id="setGuest" label="Guest access" lede="Choose which notes guests may ask about and limit their usage. Guests can ask questions and suggest changes, but cannot edit your notes. Unshared notes are excluded before the reader runs.">
            <GuestRows g={p.vm.guest} />
          </Group>

          <Group n="04" id="setLearning" label="Memory & maintenance" lede="Manage cached answers, handoff size and suggestions for keeping your notes useful. These controls maintain memory; they do not train a model. Retrieval limits are shown for reference, not changed here.">
            <LearningRows vm={p.learning} />
          </Group>

          {/* Closed by default, and carets inside it. Nine rows of env names is a reference table
              nobody asked to read, and the one person who needs it needs one row of it. The
              summary carries the only number that matters at a glance — how much of the
              deployment is wired — and each row opens onto its own three steps. */}
          <Group n="05" id="setDoors" label="Services & deployment" lede="Open a service to configure it or see what is missing. Credentials can be saved here after one-time provider setup, but are never shown again. Saving does not deploy changes. Hosting permissions and console access credentials are still managed by the provider.">
            {p.operations && <OperationsReadinessPanel view={p.operations} />}
            {p.configuration && <ConfigurationPanel view={p.configuration} />}
            <details className="setFold setFoldTop">
              <summary className="setFoldSum">
                <span className="setRowBody">
                  <span className="setLabel">Environment reference</span>
                  <span className="setSub">configuration present in this running deployment — not a connection test</span>
                </span>
                <span className="setVal setValMuted">
                  {p.doors.filter((d) => d.set === true).length} of {p.doors.filter((d) => d.set !== null).length} set
                </span>
              </summary>
              <div className="setFoldBody setFoldRows">
                {p.doors.map((d) => (
                  <DoorFold key={d.label} label={d.label} sub={d.sub} set={d.set} value={d.value} configurationAvailable={Boolean(p.configuration)} />
                ))}
              </div>
            </details>
          </Group>

          <ConnectSection {...p.connect} />

          <details className="setHow">
            <summary className="setHowSum">How model selection and limits work</summary>
            <p className="setHowP">
              For trusted questions, an allowed model requested by the caller takes priority, followed by the saved
              default, the deployment&apos;s READER_MODEL setting, then the built-in default. Fallback can ignore provider
              switches; turning one off is not an access restriction. Guests always use a Claude reader and only the
              notes you share. Guest daily limits reset at 00:00 UTC.
            </p>
          </details>
        </div>
      </div>
    </SettingsWrites>
  );
}
