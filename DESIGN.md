---
name: Cortex Console
description: A field notebook for a memory that keeps its corrections on the page.
colors:
  paper: "#f0efed"
  paper-raised: "#f7f6f4"
  paper-sunk: "#e6e4e0"
  band-grey: "#e4e2de"
  band-ink: "#14171a"
  ink-900: "#111315"
  ink-700: "#3a3f44"
  ink-500: "#5f666d"
  ink-400: "#7c848c"
  rule: "#111315"
  rule-soft: "rgba(17, 19, 21, 0.16)"
  rule-hair: "rgba(17, 19, 21, 0.08)"
  signal: "#d8500f"
  signal-on: "#ffffff"
  field-live: "#1fbdd6"
  field-warn: "#e0ad48"
  field-ok: "#4cc08a"
  field-crit: "#e8695f"
typography:
  masthead:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "clamp(96px, 13vw, 210px)"
    fontWeight: 800
    lineHeight: 0.82
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 125"
  display:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "clamp(34px, 4.4vw, 62px)"
    fontWeight: 500
    lineHeight: 1.02
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 100"
  figure:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "clamp(46px, 6vw, 78px)"
    fontWeight: 800
    lineHeight: 0.9
    fontVariation: "'wdth' 125"
  body:
    fontFamily: "Archivo, system-ui, -apple-system, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  value:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.18em"
rounded:
  none: "0"
spacing:
  row: "12px"
  section: "28px"
  band: "64px"
components:
  section-chip-number:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.signal-on}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "5px 9px"
  section-chip-label:
    backgroundColor: "{colors.paper-sunk}"
    textColor: "{colors.ink-900}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "5px 11px"
  button-primary:
    backgroundColor: "{colors.ink-900}"
    textColor: "{colors.paper}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0 16px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.ink-900}"
    textColor: "{colors.paper}"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-900}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0 16px"
    height: "44px"
  button-secondary-hover:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.signal-on}"
  field-live:
    backgroundColor: "{colors.field-live}"
    textColor: "{colors.ink-900}"
    rounded: "{rounded.none}"
    padding: "18px 20px"
  input-text:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-900}"
    rounded: "{rounded.none}"
    padding: "0 16px"
    height: "56px"
  switch-on:
    backgroundColor: "{colors.field-live}"
    rounded: "{rounded.none}"
    width: "52px"
    height: "30px"
  switch-off:
    backgroundColor: "{colors.paper-sunk}"
    rounded: "{rounded.none}"
    width: "52px"
    height: "30px"
---

# Design System: Cortex Console

*Revised 2026-09-01, after the depth and kinetic passes. The build is the source; where this file and older revisions disagree, the shipped stylesheets won.*

## Overview

**Creative North Star: "The Field Notebook"**

An operator's working record, kept by hand and never erased. Entries are dated, values sit in ruled columns, and a correction is written beside the thing it corrects rather than replacing it. The product's central convention — retracted passages stay on the page so a stale answer can be caught quoting one — is a notebook habit before it is an engineering one, and the surface is built to look like the book that habit produces.

The character is precise rather than soft. A notebook kept by someone who measures things has no rounded corners, no glows and no decorative colour; it has ruled lines, a consistent hand, and marks that mean something. Since the depth pass (2026-09-01) the paper is physical rather than flat: a sheet rests one step above the ground on a close, colourless ink shadow, a meter is a well sunk into the sheet, and the ink band is a slab that casts onto the page on both edges. Structure is still drawn — a 1px rule and a change of ground remain the primary separators — but the drawn regions now have the thickness of real paper.

Density is deliberate and varies by passage. A page alternates between full-bleed bands — paper, grey, near-black — so a long screen reads as a sequence of entries rather than one undifferentiated sheet. Within a band, values are tabular and tight; between bands there is real air. The one place the notebook raises its voice is a figure at page scale, and it earns that by being a real measurement.

**Key Characteristics:**
- Zero radius everywhere; the corner is never softened
- Depth is physical but colourless: sheets rest on offset, softly blurred ink shadows; wells sink inward; nothing ever glows
- Two families only: Archivo (one variable file, two widths) and JetBrains Mono
- Colour appears only as a filled field carrying near-black text, never as ink
- Every ID, metric and timestamp is monospace, without exception
- Full-bleed bands alternate ground; the ink band and ink card are the two dark slabs, and they cast shadow like objects
- Motion is the mechanism settling: entrances run once, armed only after load, and reduced motion gets the finished sheet

## Colors

A paper-and-ink system with two accents that never answer the same question.

### Primary
- **Signal Orange** (`#d8500f`): structure and action. Section number chips, the construction spine, chevrons that begin a list item, the border of a secondary action, the CX block that opens the masthead, and the working-state ID chips on the ink card. On the live board it marks the search match and a selection's hot edges — actions on the document. It carries white, never near-black.

### Secondary
- **Live Cyan** (`#1fbdd6`): liveness. The mirror serving from git, the active navigation tab, a `HANDOFF` tag, the memory ring's arc, the masthead chip's dot, the board's LIVE chip. It marks *a fact about data*, and it carries near-black.

### Tertiary
- **Attention Amber** (`#e0ad48`): the inbox badge and heat maxima. Never text.
- **Healthy Green** (`#4cc08a`) / **Failure Red** (`#e8695f`): reserved operational states. Both are fields, never ink.

### Neutral
- **Paper** (`#f0efed`): the default ground of every screen.
- **Raised Paper** (`#f7f6f4`): the sheet surface — cards, panels and hovered rows rest one step above the ground.
- **Grey Band** (`#e4e2de`) and **Ink Band** (`#14171a`): the two alternate grounds a section may sit on; ink also appears at card scale as the working-state slab.
- **Ink** (`#111315`): all running text and every rule at full strength. 16.20:1 on paper. Also the only pigment shadows are made of.
- **Ink Mid** (`#3a3f44`) and **Ink Soft** (`#5f666d`): secondary text and mono meta.
- **Ink Inert** (`#7c848c`): genuinely disabled controls only; never running copy.

### Named Rules

**The Field, Not Ink Rule.** No brand colour may be used as text, a stroke, or a thin mark on paper. Measured: cyan is 1.96:1 as ink and 8.25:1 as a field carrying near-black; amber is 1.78:1 and green 1.98:1. A coloured value is a filled region with near-black on top, or it is not coloured.

**The Two Questions Rule.** Cyan answers "is this live?". Orange answers "where am I, and where do I act?". They never appear for the same reason, so they never compete. A screen that uses orange for liveness or cyan for structure has broken the system, not decorated it.

**The One Meaning Rule.** An accent that fires on every member of a set is decoration wearing a signal's clothes. The pink cap this system replaced was applied to every bar in a chart and therefore encoded nothing. If a mark appears on all of them, remove it.

## Typography

**Display Font:** Archivo (with system-ui, sans-serif)
**Body Font:** Archivo (with system-ui, -apple-system, sans-serif)
**Label/Mono Font:** JetBrains Mono (with ui-monospace, SFMono-Regular, Menlo, monospace)

**Character:** One variable family does display and UI, because Archivo's width axis runs 62–125 — "Expanded" is the same file at `wdth 125`, not a second download. The wide cut is used only where a number or a heading is meant to be read across a room; running UI sits at the default width. Mono is not a stylistic choice: it is what marks a value as functional.

### Hierarchy
- **Masthead** (800, `clamp(96px, 13vw, 210px)`, 0.82, `wdth 125`): one figure per screen, at the top, answering that screen's primary question before the reader focuses. Never more than one.
- **Display** (500, `clamp(34px, 4.4vw, 62px)`, 1.02, `wdth 100`): band headings, sentence case, with the operative clause set in 800/`wdth 125` inside the same line.
- **Figure** (800, `clamp(46px, 6vw, 78px)`, 0.9, `wdth 125`): stat values inside a band.
- **Body** (400, 15px, 1.5): running prose. Ledes cap at 62–66ch; long-form text at 74ch.
- **Value** (400, 12px, mono): IDs, paths, counts, timestamps, commit SHAs.
- **Label** (500, 11px, `0.18em`, uppercase, mono): every field label, section marker and eyebrow.

### Named Rules

**The Mono Means Functional Rule.** Every ID, metric and timestamp is JetBrains Mono. A commit SHA rendered in the UI face is a bug, not a variation — this system has shipped that bug twice, both times because a token was undefined and a `font:` shorthand silently fell back to inherited.

**The Integer Rule.** Font sizes are integers. `9.5 / 10.5 / 11.5 / 12.5 / 13.8px` were em-derived accidents, not chosen steps, and a scale that cannot be recited is not a scale. Mono ladder: 10 / 11 / 12 / 13. Sans ladder: 13 / 15 / 19.

**The 11px Floor Rule.** No functional text below 11px. Anything smaller is either promoted or removed.

**The Attached Punctuation Rule.** Trailing punctuation lives *inside* the bold run it follows. Left outside, it becomes its own inline run — free to wrap onto the next line, or to render detached with a visible gap.

## Layout

The page is a sequence of **full-bleed bands**. A band breaks every ancestor's padding to reach both viewport edges, then re-inserts a `1560px` content column inside itself, so the ground reaches the edges while text stays aligned with every other section. Bands alternate ground — paper, grey, ink — and the alternation is what makes a long screen read as passages.

Escaping the gutters requires the band's containing block to be unpadded: the spine gutter therefore lives on the sheet's non-band children, never on the sheet. `.conRoot` carries `overflow-x: clip` to absorb the scrollbar's share of `100vw` — `clip`, never `hidden`, because `hidden` creates a scroll container and unsticks the masthead.

Within a band, the reading column and a subordinate rail split asymmetrically (`1fr` / `minmax(280px, 22%)`), collapsing to one column at 1100px. The masthead sits above the split, full width. Rows are grid, not flex-with-widths, so a long path truncates rather than pushing its neighbours. A row whose content is a sentence plus wrapping chips stacks vertically rather than sharing a track that crushes the sentence to one word per line.

Breakpoints: **1800px** (display wrap), **1100px** (split collapses), **900px** (mast wraps, spine narrows, tables become two-line), **700px** (settings rows stack). Below 900px the grid field is removed entirely rather than compressed.

**The Real Estate Rule.** A region that is empty collapses; it does not render at its full size holding nothing. The inbox rail becomes a single line at zero, and a screen whose every instrument is empty renders one designed statement instead of six empty instruments.

## Elevation & Depth

**This system has a physical depth vocabulary, added in the 2026-09-01 depth pass, and it is made entirely of colourless ink.** Paper here has thickness: a sheet rests raised on a close shadow that is both offset *and* softly blurred — never a glow, never a hard zero-blur slab — meters and bars sink into the page as inset wells, and the two dark slabs (the full-bleed ink band and the ink working-state card) cast onto the paper around them. `--glow-cyan` remains `none`: no brand colour ever glows, blurs or halos. Structure is still drawn first — the 1px rule and the change of ground do the separating — and shadow states the material, not the hierarchy.

### Shadow Vocabulary
- **Sheet at rest** (`--elev-1`: `0 1px 2px rgba(17,19,21,0.10), 0 3px 10px rgba(17,19,21,0.05)`): every `.card` region and raised panel. The default state of paper.
- **Sheet attended to** (`--elev-2`: `0 2px 4px rgba(17,19,21,0.13), 0 12px 28px rgba(17,19,21,0.08)`): the same sheet on hover. The shadow deepens; the sheet never translates (`transform: none` on card hover is deliberate — nine of these regions are not clickable, and a lift is an interactive affordance).
- **Sunk well** (`--sunk-well`: `inset 0 1px 3px rgba(17,19,21,0.14)`): meters, stacked bars and troughs, on the sunk-paper ground. A measurement is pressed into the page, not laid on it.
- **Ink slab cast** (on `.bandInk`, both edges: `0 2px 3px …0.20, 0 14px 34px …0.10, 0 -2px 3px …0.14, 0 -10px 26px …0.06`): the full-bleed ink band sits above the paper and shadows both the section before it and after it.
- **Masthead rest** (`0 4px 14px rgba(17,19,21,0.05)` on the sticky masthead): the chrome floats just above the page it rules.

The one texture in the system is a fine dot grain on the ink band (`radial-gradient` at 3px), because a flat black region at full-bleed scale reads as a hole in the page rather than a material.

### Named Rules

**The Ink Shadow Rule.** Every shadow is near-black ink at low alpha, offset downward and softly blurred. A coloured shadow is a glow, and a glow does not exist in this world; a zero-blur offset slab belongs to a neobrutalist world this is not.

**The Affordance Rule.** Depth may deepen under attention, but only interactive things move. A non-interactive container never translates on hover; the hover lift this system once removed was applied to nine overview panels, none of which was clickable, and it stays removed.

## Shapes

Every corner is square. Radius is `0` on buttons, inputs, switches, chips, tags, fields and containers, without exception — the token exists only so the value can be stated once.

Borders are hairlines and come in three strengths: **full ink** (`#111315`) for the rule that separates one section from the next, **soft** (16% ink) for divisions inside a section, and **hair** (8% ink) for row separators and the sheet's own edge. A border is never used to make a box; it is used to draw a line — the card's top rule at full ink is the structural stroke, and its remaining edges are hairline so the raised sheet reads as cut paper.

Two recurring geometries define the surface: the **construction grid** — dashed vertical columns with an orange crosshair at intersections, drawn behind art-carrying bands — and the **dot field**, a matrix of 6px marks where each mark is one block of one note.

## Components

### Buttons
- **Shape:** square (0 radius), minimum 44px tall, mono uppercase at `0.14em`
- **Primary:** ink ground, paper text; presses down 1px on `:active`
- **Secondary:** paper ground, ink text, 1px signal-orange border; fills orange with white text on hover
- **Tertiary:** paper ground, ink text, soft-rule border that goes to full ink on hover
- **Focus:** a 2px solid ink outline at 2px offset. Never a box-shadow — forced-colors mode drops shadows entirely, and any rule that sets `outline: none` and substitutes one is a defect.

### Chips
- **Section chip:** two abutting rectangles — an orange number carrying white, then a sunk-paper label carrying ink. Always paired, never alone.
- **Tag:** sunk-paper ground with ink text; takes a live-cyan or amber ground when it carries state.
- **Door chip:** signal-coloured when reachable, hairline-bordered and inert when not.
- **Working-state ID chip:** an orange field carrying white mono (700, 11px), stamped at the head of a row on the ink card.

### Cards / Containers
- **Corner Style:** square (0)
- **Background:** raised paper (`--paper-raised`) — the sheet rests one step above the band's ground
- **Shadow Strategy:** `--elev-1` at rest, `--elev-2` on hover; see Elevation & Depth
- **Border:** a full-ink rule on top, hairline on the remaining edges
- **Internal Padding:** `28px 26px 36px`
- **Ink variant (`cardInk`):** the working-state slab — ink-band ground, paper text, its own deeper cast; rows separated by 14%-paper hairlines, sliding right 18px on hover as a 4px orange edge draws in. The spec's black splitter at card scale, so a second full-bleed band never stacks on the page.

### Inputs / Fields
- **Style:** paper ground, 1px full-ink border, square, 44–56px tall, 15–17px body text
- **Focus:** the global 2px ink outline; no component may override it
- **Disabled:** an explicit inert ink token plus a hairline border — never `opacity`, which composited `--muted` at 40% to 2.38:1 in the system this replaced
- **Switch:** 52×30 rectangle, cyan when on, sunk paper when off, with a 22px ink knob that translates 22px. A locked switch says LOCKED in words rather than dimming into an undefined third state.

### Navigation
- Mono uppercase at 11px, `0.13em`, full-height in a 56px bar with one full-ink rule beneath it; the bar itself rests on the masthead shadow (`0 4px 14px` at 5% ink)
- **Active:** a live-cyan field carrying near-black — selection is the chrome's one piece of live state
- **Hover:** a 2px ink underline that grows from the left edge
- **Badge:** an amber field carrying near-black; inverts to ink-on-cyan when its own tab is active

### The Corpus Field (signature)
A matrix of 6px marks, one per block of one note, hairline when live and full ink when retracted. It is an addressable index, not an illustration: hovering reads out the note and block number, and clicking opens the ledger filtered to that note. When its section reveals, the marks *pop* in sequence — each mark scaling up from zero on its own `--d` delay, staggered so the last lands under a second regardless of corpus size. It reads from the same `strip` the ledger renders, so the art cannot drift from the data.

### The Live Board (signature)
The map is the console's one instrument that is a canvas, and since the depth pass it lives in the same paper world: warm paper knock (`#f0efed`), true-ink labels, hairline ink edges, and signal orange only where the board runs hot — the search match and a selection's edges, because those are actions on the document. Liveness is a cyan chip carrying near-black, per the two-questions rule. Chrome is a solid raised-paper panel (no translucency), square everywhere, with ink shadows from the same vocabulary. Icons are drawn strokes — 16px grid, `currentColor`, 1.8px weight — never unicode glyphs; brand marks are real 24-unit paths rasterised once per size. Default physics are force layout with live springs; slider readouts are mono ink.

## Do's and Don'ts

### Do:
- **Do** use colour as a filled field carrying near-black text (`#111315`), never as ink, a stroke or a thin mark.
- **Do** keep cyan for liveness and orange for structure and action — a screen that swaps them has broken the system.
- **Do** set every ID, metric, path and timestamp in JetBrains Mono.
- **Do** use integer font sizes from the two ladders (mono 10/11/12/13, sans 13/15/19).
- **Do** separate regions with a 1px rule and a change of ground; use shadow to state material, not hierarchy.
- **Do** take depth from the three tokens — `--elev-1` at rest, `--elev-2` attended, `--sunk-well` for anything pressed into the page — always colourless ink, offset and softly blurred.
- **Do** give every interactive control a minimum 44px target.
- **Do** collapse an empty region to a single line rather than rendering it at full size holding nothing.
- **Do** put trailing punctuation inside the bold run it follows.
- **Do** drive entrances through the kinetic contract: server markup carries `data-cx="rise|print|rule|flood"` (optional `--cx-d` stagger), one `cxReady` class arms the root strictly after load, an IntersectionObserver adds the single reveal class once, and every keyframe uses `backwards` fill so no animation pins a final transform over a state class. Server-rendered markup only — a client re-render strips the reveal and re-hides settled content.

### Don't:
- **Don't** introduce a radius. Every corner in this system is square, including inputs and switches.
- **Don't** add a glow, a coloured shadow, glass, or a zero-blur offset slab. `--glow-cyan` is `none` and stays `none`; the only shadow pigment is ink.
- **Don't** invent a shadow value. Depth comes from the named tokens and the two slab casts; a fourth elevation is a new material this paper does not have.
- **Don't** add a third font family. Archivo covers display and UI through its width axis; mono is the only other voice.
- **Don't** express a disabled state with `opacity` — use the inert ink token, or the control becomes unreadable exactly when its message matters most.
- **Don't** override `:focus-visible` with a box-shadow, and never pair `outline: none` with one.
- **Don't** put a working surface on the full-bleed ink band. Ink grounds are for display and explanation — the `cardInk` slab carries read-and-jump rows, but a queue you triage, a form you fill and a table you scan all belong on paper.
- **Don't** make anything depend on motion to be readable. With JavaScript off, before hydration, or under `prefers-reduced-motion`, the page is the finished sheet from first paint — reduced motion is a hard gate that never arms, not a shorter animation.
- **Don't** reference a `var(--…)` that is not defined in `theme.css`. An undefined token inside a `font:` or `transition:` shorthand silently invalidates the whole declaration — this system has lost four type rules and forty-eight transitions to exactly that.
- **Don't** animate opacity on text from zero outside the armed kinetic layer. Motion moves grounds and transforms; a paint that never runs must still show the numbers.

---

## Appendix: the public surface

`/` is **not** on this system. It shares `app/globals.css`, which remains the original dark OBELYTH world — deep-slate ground (`#0f1318`), matte off-white text, one electric-cyan accent, `color-scheme: dark`, and an 8px radius vocabulary.

This is deliberate scope, not drift. The light world is declared on `.conRoot` rather than `:root` precisely so the public page keeps its own system; redesigning it was explicitly out of the console redesign's brief. Two consequences bind any future work:

1. **Changing `:root` in `globals.css` changes the public page.** Console tokens belong in `theme.css`.
2. **A semantic alias must be re-declared wherever its underlying scale is overridden.** `--ink: var(--ink-900)` resolves at the element where it is *declared*, so a band that overrides `--ink-900` and not `--ink` will paint near-black text on a near-black ground. Both layers move together, or neither does.
