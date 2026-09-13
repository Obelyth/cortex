---
name: Cortex Console
description: An authenticated operations console with a default Ink ground and an optional Paper ground.
colors:
  ink-ground: "#0f1318"
  ink-surface: "#151b22"
  ink-surface-raised: "#1a212b"
  ink-sunk: "#0b0e12"
  ink-text: "#e9edf2"
  ink-bright: "#f6f8fb"
  ink-muted: "#aeb8c4"
  ink-faint: "#8b97a4"
  ink-disabled: "#677483"
  ink-line: "#33404f"
  ink-hair: "#232c37"
  cyan: "#1fbdd6"
  cyan-high: "#3ed3e6"
  orange: "#d8500f"
  amber: "#e0ad48"
  red: "#e8695f"
  green: "#4cc08a"
  paper-ground: "#e4e2de"
  paper-surface: "#eeece8"
  paper-surface-raised: "#d9d6d0"
  paper-sunk: "#dad7d1"
  paper-text: "#111315"
  paper-muted: "#3a3f44"
  paper-faint: "#505860"
  paper-disabled: "#7c848c"
  paper-line: "rgba(17,19,21,.28)"
  paper-hair: "rgba(17,19,21,.1)"
  paper-cyan: "#096475"
  paper-cyan-high: "#075565"
  paper-amber: "#75540e"
  paper-red: "#a43729"
  paper-green: "#1c693f"
typography:
  masthead:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "clamp(80px, 10vw, 160px)"
    fontWeight: 800
    lineHeight: 0.85
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 125"
  display:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "clamp(30px, 3.6vw, 56px)"
    fontWeight: 500
    lineHeight: 1
  body:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  value:
    fontFamily: "JetBrains Mono, ui-monospace, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "JetBrains Mono, ui-monospace, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.14em"
rounded:
  control: "4px"
  instrument: "6px"
  switch-track: "13px"
  circle: "50%"
spacing:
  compact: "8px"
  control: "12px"
  gutter-mobile: "14px"
  content: "28px"
  section: "44px"
components:
  button-primary:
    backgroundColor: "{colors.cyan}"
    textColor: "{colors.ink-ground}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "44px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink-text}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "44px"
  input:
    backgroundColor: "{colors.ink-sunk}"
    textColor: "{colors.ink-text}"
    typography: "{typography.value}"
    rounded: "{rounded.instrument}"
    padding: "10px"
    height: "44px"
  chip:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "2px 7px"
  panel:
    backgroundColor: "{colors.ink-surface}"
    textColor: "{colors.ink-text}"
    rounded: "{rounded.instrument}"
    padding: "18px 20px"
  switch-on:
    backgroundColor: "{colors.cyan}"
    rounded: "{rounded.switch-track}"
    width: "46px"
    height: "26px"
  switch-off:
    backgroundColor: "{colors.ink-sunk}"
    rounded: "{rounded.switch-track}"
    width: "46px"
    height: "26px"
---

# Design System: Cortex Console

## Overview

**Creative North Star: "The Field Notebook"**

Cortex Console is a precise operations surface built from dark ink, measured rules, compact instruments, and graph-paper texture. Ink is the default ground. Paper is an optional per-device setting that swaps the semantic token dictionary while preserving the same structure, hierarchy, controls, and state meanings.

The console is authenticated and operational, not a public landing page. Its five primary tabs are Ops, Overview, Ask, Trends, and Settings. Overview is the sole working-context editor and includes an explicit None project choice. Ask links back to that editor. The anonymous root remains a 404, and authenticated legacy Map routes exist only to redirect to Ask.

**Key Characteristics:**

- Ink by default, with a complete Paper token dictionary rather than a separate layout
- Archivo for display and interface text, with JetBrains Mono for labels and functional values
- Compact 4px controls inside 6px instruments, with the switch as the intentional pill exception
- Cyan for live state and primary action, orange for structural markers, and status colors for operational meaning
- Hairlines, sunk troughs, restrained shadows, and fine dot or graph-paper texture
- Five primary tabs with one working-context editor on Overview

## Colors

The palette is a semantic pair of grounds. Components read shared roles such as ground, surface, ink, line, accent, and status; the Ink or Paper dictionary supplies the concrete value.

### Primary

- **Live Cyan:** Active tabs, links, focus, selected states, live state, and primary actions. The Paper ground uses its darker cyan pair to preserve contrast.
- **Signal Orange:** Section-number fields, structural markers, and action edges. It is not a replacement for the primary interactive accent.

### Tertiary

- **Attention Amber:** Warnings and pending attention.
- **Critical Red:** Errors, refused states, and critical counts.
- **Healthy Green:** Confirmed success and healthy status.

### Neutral

- **Ink Ground Family:** Near-black ground, layered dark surfaces, pale text, blue-grey rules, and muted functional text.
- **Paper Ground Family:** Warm paper ground, light surfaces, near-black text, and low-alpha ink rules.
- **Inverted Regions:** Each ground has a paired opposite surface for strong explanatory or query bands. Text and accent roles invert with the surface.

### Named Rules

**The Semantic Ground Rule.** Screens consume semantic roles. Do not hard-code a ground-specific neutral where the same component must work on Ink and Paper.

**The Signal Rule.** Cyan marks interaction and live state. Orange marks structure. Amber, red, and green carry operational status only.

## Typography

**Display Font:** Archivo with system-ui and sans-serif fallbacks

**Body Font:** Archivo with system-ui and sans-serif fallbacks

**Label/Mono Font:** JetBrains Mono with ui-monospace, Menlo, and monospace fallbacks

**Character:** Archivo provides a restrained interface face and an expanded display voice through its width axis. JetBrains Mono makes paths, identifiers, timestamps, metrics, controls, and compact metadata scan as functional information.

### Hierarchy

- **Masthead** (800, responsive, expanded width): The one dominant figure on Overview.
- **Display** (500, responsive): Screen and band headings, typically between 30px and 56px depending on the surface.
- **Body** (400, 14px, 1.5): Default interface prose. Longer explanations commonly use 13px to 15px with a 1.55 to 1.6 line height.
- **Value** (400, 12px, mono): Paths, counts, timestamps, code-like values, and measured readouts.
- **Label** (500, 11px, mono, uppercase): Navigation, field labels, chips, and compact actions. Dense metadata may step down to 10px.

### Named Rules

**The Mono Means Functional Rule.** Use JetBrains Mono when text is an identifier, path, timestamp, metric, state label, or control label. Use Archivo for prose and descriptive titles.

## Layout

The shell uses a sticky 52px masthead and a centered content region capped at 1560px. Desktop content uses 28px horizontal gutters and 44px of air above the first instrument. Below 900px the shell gutters contract to 14px, the wordmark is removed, and tabs remain horizontally scrollable.

Screens combine full-width inverted bands with responsive instrument grids. Repeated panels use auto-fitting columns and collapse naturally rather than preserving empty tracks. Dense data rows are grid-based so paths and values can truncate without displacing adjacent columns. Ask is a vertical sequence: query band, answer readout, then corpus explorer.

**The One Editor Rule.** Working context is edited only on Overview. None means no project selected and does not remove saved notes. Ask may link to this editor but must not duplicate it.

## Elevation & Depth

Depth is restrained and structural. Instruments use a close ambient elevation, inset troughs hold inputs and charts, and inverted bands or drawers use a stronger cast. Fine dot grain and graph-paper lines add material texture without introducing a second palette.

### Shadow Vocabulary

- **Ambient Instrument:** A close two-layer shadow for surfaces at rest.
- **Cast Surface:** A deeper shadow for inverted bands, drawers, and attended surfaces.
- **Sunk Trough:** An inset shadow for fields, chart wells, and recessed controls.
- **Bezel:** A subtle combination of inset highlights, inset shade, and a small outer cast for instrument panels.

### Named Rules

**The Structural Depth Rule.** Use shadow to distinguish material level or interaction state. Keep non-interactive regions still.

## Shapes

The default form language is compact and slightly softened. Instrument panels, troughs, and inputs use 6px corners. Buttons, chips, steppers, and inset row ends use 4px corners. The 46px by 26px switch is the deliberate pill exception, with a circular 18px knob. Hairline borders and partial-radius rows remain valid when they clarify direction or selection.

## Components

### Buttons

- **Shape:** Compact 4px corners with a 44px standard target.
- **Primary:** Cyan field with the ground-appropriate on-accent text.
- **Secondary:** Transparent surface with a semantic line border and current text color.
- **Hover / Active:** Borders move toward accent, interactive buttons may move 1px, and disabled controls remain still with explicit disabled color.
- **Focus:** A 2px solid accent-high outline at 2px offset, never a shadow-only focus treatment.

### Chips

- **Style:** Compact mono uppercase labels with 4px corners and a 1px current-color border.
- **State:** Selected chips fill with cyan. Warning, critical, healthy, and live chips use their semantic state color.

### Cards / Containers

- **Corner Style:** 6px for instrument panels. Ruled regions may remain square when they are table-like rather than container-like.
- **Background:** Semantic surface or band color, with the opposite-ground dictionary reserved for inverted regions.
- **Shadow Strategy:** Ambient, cast, trough, or bezel according to material role.
- **Border:** Semantic line for section boundaries and hair for internal divisions.

### Inputs / Fields

- **Style:** Sunk ground, semantic line border, 6px corners, mono values, and at least a 44px target.
- **Focus:** Global accent-high outline. Compound fields may also strengthen their enclosing border.
- **Disabled:** Explicit disabled text and hairline border. Do not use opacity as the only disabled cue.

### Navigation

The 52px masthead carries five uppercase mono tabs: Ops, Overview, Ask, Trends, and Settings. Tabs use 11px type with 0.14em tracking. Hover draws a line-colored underline and the active tab uses a cyan underline. The tabs scroll horizontally when space is constrained.

### Switch

The settings switch is a 46px by 26px pill on a sunk trough. Its 18px circular knob moves 20px. On fills the track with cyan. Off uses the sunk neutral. A locked switch includes the word locked instead of relying on dimming alone.

## Do's and Don'ts

### Do:

- **Do** use the semantic token dictionary so one component remains legible on Ink and Paper.
- **Do** reserve cyan for active interaction and live state, orange for structure, and status colors for their named states.
- **Do** use 6px corners for instruments and 4px corners for inset controls.
- **Do** keep paths, IDs, metrics, timestamps, and compact control labels in JetBrains Mono.
- **Do** keep working-context editing on Overview, including the explicit None state, and link to it from Ask.
- **Do** make reduced-motion output readable in its finished state.

### Don't:

- **Don't** restore a zero-radius-only rule. The shipped system uses 6px instruments, 4px controls, and a pill switch.
- **Don't** introduce a second working-context editor or treat None as deletion.
- **Don't** present Map as a current screen. Authenticated Map addresses are compatibility redirects to Ask.
- **Don't** treat the anonymous root as a public product page. It intentionally returns 404.
- **Don't** add generic card names or dark slab variants as system primitives when the shipped surfaces use semantic panels, bands, troughs, and ruled regions.
- **Don't** use shadow as the only focus indicator or opacity as the only disabled indicator.

## Material and motion

Paper uses a dim warm ground and darker cyan text. Both grounds keep fine dot textures behind content, shallow pooled shading, and softly feathered structural rules. Rounded caps finish joined labels; inset interactive rows retain their directional border.

The masthead uses an 8px backdrop blur on its empty pseudo-element. The masthead itself stays free of a backdrop filter so the fixed Notices tray remains attached to the viewport. An opaque ground replaces the effect when reduced transparency or forced colors is requested. Notices retains a native backdrop button, Escape dismissal, and focus restoration.

Section headings may move three pixels once over 220ms after entering the viewport. Data and controls remain readable before hydration, if observation fails, and under reduced motion. Selected controls carry one optional dot sweep on pointer hover; disabled, busy, touch, reduced-motion, and forced-color states suppress it. Chart strokes keep their full geometry.

Cursor accent is off by default and saved for the current browser. When enabled on a wide desktop with a fine mouse pointer, a hollow orange and teal outline turns slowly around the native pointer. It is decorative, has no hit area, and disappears during editing, selection, drag, keyboard use, hidden-page states, reduced motion, or forced colors.

The public Overview keeps its existing working notes and project preview. Instruments share a reading grid, Recent saves has a keyboard-focusable bounded viewport, and the Ops Timeline scrolls within the height set by Decisions. Reader rows expose all metrics in narrow layouts rather than hiding columns.

## Verification boundary

This presentation port was checked against a production build using the unchanged blank starter corpus and synthetic provider responses. Browser checks cover all five screens in Ink and Paper at desktop and narrow widths, Notices containment and focus restoration, the optional cursor and reduced motion, and anonymous-route rejection. These checks validate layout and client behavior; they are not proof of live provider writes, production migrations, or a deployed account's data state.

The September 13 confirmation passed 30 layout/theme/viewport scenarios at 320, 390
and 1440 CSS pixels, plus cursor opt-in, reduced-motion and anonymous/wrong-secret
404 checks, with no page errors. Node 22 typechecking and the production build passed.
The unit suite passed 2,947 tests with 177 environment-gated skips. A separate enforced
private-corpus export gate passed all 11 tests with zero skips and blocked test network
access; the default suite's skips are not privacy evidence. The blank template and
backend, authorization, migration and provider configuration remain unchanged.
