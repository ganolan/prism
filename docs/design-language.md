# Prism Visual Language — captured insights (DRAFT)

> **Status: DRAFT / working notes — not yet ratified.**
> These are the design decisions we converged on while iterating on the PrisMCP
> assessment UI (`/assessment/:id`, June 2026). They are captured here so the
> thinking isn't lost; they are **not** a finished system. The intent is to
> brainstorm/confirm and expand this into a ratified design language + shared
> primitives later. Tracked by the design-language issue on the board.
>
> **Important caveat:** almost everything below currently lives as **inline
> styles inside `client/src/pages/AssessmentSummaryPage.jsx`**. The patterns are
> real but not yet reusable — applying them consistently across Prism is a
> separate, deferred task (extract to shared CSS classes in `app.css` and/or a
> few small components). See "Phases" at the bottom.

## Why this exists

We made many deliberate visual decisions on the assessment page (cell language,
pills, control bands, status indicators, the whole-class command bar). They form
a coherent language, but it's trapped in one file. Before rolling it out we want
to (a) name the principles, (b) catalogue the concrete tokens, and (c) decide how
to make it enforceable rather than copy-pasted.

---

## Principles (the load-bearing ideas)

1. **Status, not commands.** A control/indicator names the *current state*; the
   control's own position carries the affordance. Don't label a toggle with an
   imperative that fights its position.
   - Bulk visibility toggle reads `All shown` / `All hidden` / `Mixed` (state),
     not `Display all` / `Hide all` (command), or `No comments` (disabled) when
     no shown card has a comment (#184). The switch position says on/off.
   - Comment border: green = published, amber = draft. The colour *is* the state.

2. **No layout shift on state change.** Any control whose content varies between
   states gets **fixed dimensions**; a state change recolours/restyles but never
   resizes. Reflow reads as jank and (with hover states) can flicker.
   - Header pills: fixed `height: 1.8rem`, `box-sizing: border-box`, `white-space:
     nowrap`, icon in a fixed-width box — so the inactive (1.5px border) vs active
     (2.5px border) transition doesn't grow the header band.
   - Hover-to-clear keeps the **same label text/width**; only the icon + styling
     change (✕ + strike-through + danger tint), so the pill never resizes.
   - The bulk visibility label is a **fixed-width** span so `All shown` ↔ `Mixed`
     doesn't shuffle neighbouring buttons.

3. **One colour language with semantic roles.** Colour means the same thing
   everywhere. Use the `app.css` CSS variables — never hardcode hex in components
   (the one deliberate exception is the rubric cell palette, below).
   - `--accent` — primary action / brand (Publish, primary buttons).
   - `--success` — *published / synced-good* state (the comment "✓ Published" border).
   - `--warning` — *draft / needs-attention* (unsaved comment; "⚠ Ungraded
     resubmission — review").
   - `--danger` (+ `--danger-bg`) — *revert / destructive* (Discard, Discard all).
     Red specifically signals "this reverts/removes," not just "error."

4. **Related but distinguishable.** Controls that do the same thing at different
   *scopes* share a visual but are clearly differentiated.
   - The per-card visibility toggle and the bulk one share the eye + switch
     visual; the bulk one adds a status label and lives in a distinct bar.
   - **Display needs a comment (#183, 23 Oct 2026).** Schoology keeps Display off on a
     record with no comment, whatever was sent. After a publish with an empty comment, the
     card's switch shows off and holds no change, so the bulk label counts that card as hidden.
   - Distinct scope ⇒ distinct chrome: whole-class/destructive actions sit in a
     "command bar" (subtle surface + accent left-stripe) so they can't be
     mistaken for a single card's controls when stacked.

5. **Destructive bulk actions confirm in place.** A second, explicit click —
   "Discard all" → "Click again to confirm" (turns solid red) — rather than a
   modal. Per-item destructive actions (single discard) don't need it.

6. **Alignment for scannability.** Action clusters that repeat across rows are
   **right-aligned** so they share a vertical plane regardless of variable content
   (e.g. student-name length), making a column of cards scannable.

7. **Sizing parity signals peer actions.** Controls that are peers in importance
   share type size/weight (e.g. Discard text matches Publish at `0.85rem`/`600`;
   pills match the control-band buttons). Size difference should mean something.

---

## Token & pattern catalogue (as built)

> Concrete values we used, for reference when extracting shared primitives. Hex
> values shown are the ones currently inline; most should map to CSS vars on
> extraction. The rubric palette is the intended exception.

### Rubric cell language (deliberate inline exception)
Per measurement level (`ED/EX/D/EM/IE`), five families — the **only** place
colour carries grade meaning, so it stays inline (`LEVEL_COLORS` in `client/src/lib/masteryLevels.js`):

| Role | Treatment |
|---|---|
| Header / Final fill | the level's saturated tint (e.g. ED `#bfdbfe`) |
| **Final** | header-tint fill + `2px solid` level border + bold + black text |
| **Draft** | very faint fill + **`2px dashed`** level border + normal weight |
| **Suggestion** (reviewer) | `1px dashed #a78bfa` violet outline + ✦ glyph + violet wash when no teacher mark |
| **Staged removal** | default fill + `1.5px dashed #ef4444` outline + ✕ glyph |
| Cell text | always black `#1a1a1a` (colour never carries meaning in the text) |

Key idea: **solid vs dashed border** distinguishes final (committed) from draft
(tentative); outlines (violet/red) are reserved for overlays (suggestion/removal)
so they compose without clashing with the border.

### Semantic colours (use the vars)
`--accent #7c3aed` · `--success #10b981` · `--warning #f59e0b` ·
`--danger #ef4444` / `--danger-bg`. (All defined per-theme in `app.css`.)

### Status pill (header flags — `HeaderPill`, removed 21 Oct 2026)
`HeaderPill` existed only for Flag for review (#20) and went with it (#40). The pattern below is kept as the
record of how a header pill toggles; the card header's remaining pills are `.resubmit-pill` (Ask to resubmit)
and the Refer / Extend controls, and the Flags menu (#40) takes the place Flag for review held.
- **Inactive:** `1.5px solid <accent>` border, `--card-bg` background, `--text-muted`
  text, accent-coloured icon. Click → activates.
- **Active:** `2.5px solid <accent>` border, filled (`<accentBg>` / `<accentText>`).
  Click → clears. **Hover** → icon swaps to ✕, label strike-through, danger tint
  (the "this removes it" affordance), label width unchanged.
- Fixed `height 1.8rem`, `border-box`, `nowrap`, `0.85rem`/`600`.

### Control band (per-card actions)
- Horizontal flex; peer buttons share height (`align-self: stretch`) and text size.
- Icon + label buttons; the destructive one (Discard) carries the danger accent
  (border + `--danger-bg` + `--danger` text) when active.
- A small status badge (pending count) sits inline with the actions.

### Command bar (whole-class / bulk)
- Sticky, `z-index` above rubric cells; **distinct chrome**: `--bg-subtle` surface,
  `4px solid var(--accent)` left stripe, stronger shadow — visibly *not* a card.
- Holds the bulk peers of per-card controls (Publish all, Discard all, bulk
  visibility), with the destructive one gated by confirm-in-place.

### State indicators
- **Comment publish state:** textarea border + a short status label — green
  "✓ Published to Schoology" (matches synced DB value) / amber "● Draft - not
  published" (differs) / neutral (empty). Verified against `student.grade_comment`
  (the local mirror of the Schoology value).
- **Detected resubmission:** prominent amber `⚠ Ungraded resubmission — review`
  badge — an actionable "regrade me" signal, distinct from the teacher's
  Prism-local "Ask to resubmit" flag.

### Help affordance — `.help-dot` + instant popover (first shared extraction)
A stand-out circular **?** that reveals an **instant** popover on hover/focus —
no native-`title` delay. First built inline as the gradebook `HelpDot`
(`CoursePage.jsx`); now extracted to reusable `app.css` classes and used by the
Sync dialog's recent-only control (June 2026; that control was removed on 20/10/2026).
- **`.help-dot`** — 16px circle, `var(--accent-subtle)` fill, `1px solid
  var(--accent)` border, accent **?**, `cursor: help`. Hover/focus → fills
  `var(--accent)` with a white glyph, so it reads as interactive and stands out
  enough to be noticed.
- **`.help-pop`** — `position: fixed` box placed from the dot's
  `getBoundingClientRect()` (fixed so a modal's `overflow` can't clip it);
  `var(--card-bg)` + `1px solid var(--border)` + `0 8px 28px rgba(0,0,0,.18)`
  shadow, `pointer-events: none`. Appears the instant the dot is hovered/focused.
- **A11y:** the dot carries the full explanation as `aria-label` (screen readers
  don't need the popover) and sits *outside* the `<label>` so clicking it never
  toggles the control.
- Follow-up: migrate the gradebook's inline `HelpDot`/popover onto these classes.

### Number stepper — `.number-stepper` (`[−] N [+]`)
A bounded integer input that reads as a *value*, not a form field, until edited.
- One bordered pill wraps prominent filled **`.number-stepper__btn`** −/+ controls
  (`var(--bg-subtle)`, accent glyph, ~1.9rem hit target; hover fills accent/white)
  flanking a borderless, transparent, centred number.
- Native `type=number` spinner arrows are hidden (`appearance: textfield` +
  `::-webkit-*-spin-button`) so digits never clip; the number gains a
  `var(--bg-subtle)` wash only on `:focus` — "plain text until you click it."
- Optional `step` (default 1) sets how far −/+ move; a typed value snaps to the
  nearest multiple of it, then clamps (test day: 5 minutes, 5%, #160). Optional
  `suffix` ("min", "%") is muted display text after the number inside the pill
  (`.number-stepper__suffix`); it is never part of the value.

### Opt-in toggle phrasing
Scope-narrowing checkboxes in the same cluster share a verb for parallelism:
`Include hidden courses` / `Include only recent submissions` — not a mix of
"Include…" and "Only check…".

---

## Open questions (resolve in the brainstorm)

- **Naming/taxonomy.** `app.css` already has `.badge`. What's the line between
  *badge* (passive label) and *pill* (interactive flag)? Name the primitives
  (`StatusPill`? `CommandBar`? a `state-border` helper? the eye-switch?).
- **Extraction boundary.** Which patterns become CSS classes vs React components?
  How much stays inline (rubric palette clearly does)?
- **Colour roles.** Prism has one palette since #133 (Midnight and Ocean removed);
  still verify `--success`/`--warning`/`--danger` contrast and colour-blind
  distinguishability.
- **Rollout order.** Which surfaces first — Course, Student, Feedback, Dashboard,
  gradebook cells? Where do the patterns most obviously diverge today?
- **Motion.** We used short `0.12–0.15s` transitions ad hoc; standardise?

---

## Phases (deferred work)

1. **Define** — brainstorm/confirm the principles + names; ratify this doc; record
   the decision as an ADR.
2. **Make it enforceable** — extract the recurring patterns from inline styles
   into shared `app.css` classes and a few small components, so new code inherits
   the language by default.
3. **Apply** — audit the other surfaces against the language; fix cheap
   divergences; file the rest as issues.

## Source of truth (where the patterns live today)

`client/src/pages/AssessmentSummaryPage.jsx` — the control band, the
comment publish indicator, and the whole-class command bar. (The proficiency-level
palette, formerly `CELL_COLORS` here, is now the canonical `LEVEL_COLORS` in
`client/src/lib/masteryLevels.js` — see "Canonical level palette" above.)
`client/src/app.css` — the semantic CSS variables and the existing `.badge` /
button classes.

**First reusable extractions (Phase 2 started, June 2026):** `.help-dot` /
`.help-pop` and `.number-stepper` (component: `client/src/components/NumberStepper.jsx`)
now live as shared classes in `client/src/app.css` — used by the Sync dialog.
New UI should reuse these rather than re-inlining a help "?" or a number spinner.

---

## Rubric-descriptor visual language (June 2026, branch `feat/rubric-descriptors`)

> Added alongside the descriptor grid, compact-grid, and reviewer-analysis features.
> Cross-references: spec `docs/superpowers/specs/2026-06-08-rubric-descriptors-design.md`,
> plan `docs/superpowers/plans/2026-06-08-rubric-descriptors.md`, issue #80.

### AI-suggestion accent (fuchsia)

All AI / reviewer-suggestion surfaces share a single, unmistakable fuchsia accent so
the teacher always knows at a glance what is machine-originated vs human-committed:

- **Colour token `--ai-suggest: #e21ad6`** — defined in `client/src/app.css :root`.
  Used for borders, glyphs, and text that identifies a suggestion.
- **Wash token `--ai-suggest-wash: #fbe6fb`** — the very-light fuchsia background
  applied to suggested cells, keeping the descriptor text readable while marking the
  cell as "proposed, not confirmed."
- **Glyph — `AiSparkle` component** (`client/src/components/AiSparkle.jsx`): a
  3-star "AI magic" sparkle SVG with `fill: currentColor`, so callers control the
  hue by setting `color` (e.g. `style={{ color: 'var(--ai-suggest)' }}`). A 17 px
  corner sparkle appears in the descriptor grid's suggested cell; the compact grid
  renders an analogous overlay.

Surfaces that use this accent consistently (never mix it with another affordance):
the descriptor-grid suggested cell (sparkle + wash), the compact-grid suggestion
overlay, the "Reviewer Analysis" drawer button and its header, and the narrative
"Suggested feedback / Use suggestion" block.

The suggestion accent and the reporting-category palette are both configurable in
`config.yaml` under `rubrics:` (server-side) and surfaced to the client via
`GET /api/rubrics/config`.

### Selection borders — inset / cell-hugging

Rubric selection states sit **inside** the cell boundary so they never bleed into
neighbouring cells regardless of layout engine. All three commitment levels use an
inset technique:

| State | Treatment |
|---|---|
| **Final** | `box-shadow: inset 0 0 0 2px <level-colour>` — solid, 2 px, fully inset |
| **Draft** | `outline: 2px dashed <level-colour>; outline-offset: -1px` — dashed inset |
| **Staged deletion** | `outline: 2px dotted #ef4444; outline-offset: -1px` + enlarged corner **×** glyph |

The compact grid uses the analogous `CELL_COLORS` per-level fill treatment (header
tint → final fill; faint tint → draft; etc.) rather than outline strokes, but the
same solid-vs-dashed vs dotted vocabulary carries across both views.

Key principle (extended from the earlier rubric-cell language): **solid = committed,
dashed = tentative, dotted = pending removal**. Outline-based overlays (fuchsia
suggestion, red deletion) compose without clashing because they sit on a different
CSS property than the border used for level colour.

### Level headers — full wording, colour-coded

Level headers in the descriptor grid show the **complete proficiency-level label**
(`Exhibiting Depth`, `Exhibiting`, `Developing`, `Emerging`, `Insufficient
Evidence`) — never an abbreviation. Each header is colour-coded to its level using
the canonical proficiency-level palette, giving the teacher an immediate visual
anchor before reading the descriptors.

**Canonical level palette (June 2026, `feat/proficiency-scale-ownership`).** The
five-level colour palette — `LEVEL_COLORS` (`{ headerFill, draftFill, finalBorder,
draftBorder }`) plus `CELL_TEXT = '#1a1a1a'` — has a single home in
`client/src/lib/masteryLevels.js`, sourced from `AssessmentSummaryPage`'s palette
(the richest of the former copies). Every level-coloured surface imports it: the
gradebook + overall-mastery view (`CoursePage`, `MasteryPerformanceSummary`), the
student profile (`StudentPage`), the override modal (`OverridePopup`), the rubric
descriptor/compact grids, and `AssessmentSummaryPage` itself. Field convention:
`headerFill` = cell background, `CELL_TEXT` = cell text (one dark tone for **all**
levels, not per-level), `finalBorder` = committed border, `draftBorder` =
tentative/draft. *Deferred:* migrate these hex values to CSS custom properties
(`--level-ed-*` …) per the theming rule so theme-switching applies.

**Column balance (23 Oct 2026, #176).** `RubricDescriptorGrid` used to fix the five level
columns at 15% each, so the topic column always took the other 25% whatever it held.
Measured on 23 Oct 2026 on the student page at a 1440 px window: the grid was 1045 px
wide, the topic column 261 px and each level 157 px; the first row was 200 px high, the
topic cell's 108 characters filled 74 px of it, and the 254 characters of the Exhibiting
Depth cell set the row's height. Now the topic column is `width: '16%'` with
`minWidth: 140` and the level headers carry no width, so the five levels share the rest by
their content and a long descriptor widens its own column instead of lengthening the row.
This reaches every page that draws the grid (the assessment page, the student page and the
gradebook pop-up), which is intended. Test: `RubricDescriptorGrid.test.jsx`.

### Reporting-category colour — topic column only

Category colour is applied to the **topic (first) column only**. The default palette
for Art & Design is `#B4A7D6` (Produce) and `#9FC5E8` (Create / Respond / Connect),
but the palette is config-driven and subject-agnostic: `client/src/lib/rubricColors.js`
resolves a category title to a colour via a lowercase keyword-contains match against
the `rubrics.categoryColors` map in `config.yaml`, falling back to `var(--bg-subtle)`
for unknown categories.

Descriptor cells themselves stay neutral (`--card-bg`). Keeping colour out of the
descriptor columns ensures that the green selection border and the fuchsia suggestion
wash both read clearly against a plain background — coloured descriptor cells would
compete with both.

### Rubric management modal + reorder (June 2026, branch `feat/rubric-binding-and-mcp`)

- **Single rubric-editing hub.** All rubric editing for an assignment lives in one
  tabbed modal — **Attach · Map criteria · Row order** (`RubricManagerModal.jsx`),
  opened by a single "Manage rubrics…" toolbar button. The grading grid stays
  grading-only (no edit affordances). Map/Row-order tabs enable only when a rubric
  is attached.
- **Destructive delete confirms in place.** Deleting a rubric attached to N
  assignments shows "attached to N", and the 🗑 turns into "Click to confirm" on
  first click (second click deletes) — per the existing confirm-in-place principle.
- **`ReorderableList` (reusable).** Grip + ↑/↓ buttons (keyboard: ArrowUp/ArrowDown
  on a focused row) + a `box-shadow: inset 0 2px 0 0 var(--accent)` top drop-target
  highlight during drag. Use this for any future reorderable list rather than
  re-inlining drag handlers.
- Dates render `toLocaleDateString('en-GB')` (DD/MM/YYYY), per the date convention.

### Inline rename + one-step topic reassign (June 2026, #112 / #109)

- **Inline rename (✎ → in-place input).** Library rows in the Attach tab carry a
  `.ghost` ✎ button that swaps the name for an inline `<input>` (Enter commits via
  `renameRubric` → `onChanged()`+refresh, Esc/blur cancels). The input's keydown
  **stops propagation** so Esc cancels the *edit* without bubbling to the modal's
  window-level Escape-to-close handler — a reusable rule for any in-modal inline
  editor. Same lightweight, no-extra-chrome spirit as the confirm-in-place delete.
- **Annotate, don't hide, taken options.** The Map-criteria `<select>` offers
  **every** topic (1:1 is preserved by the server, not by filtering the UI). A topic
  already held by another criterion is shown as `Title — now: {owner}` rather than
  omitted, so picking it reassigns in one step (the server's `setMapping`
  move-semantics frees the previous owner, which re-renders as ⚠). Prefer annotating
  an option over removing it whenever the underlying action is safe — it keeps the
  full choice set visible and the consequence legible.

## Draft proficiency cell fill (assessment rubric)

Selected-but-unpublished (draft) proficiency cells fill with the level's own
`draftFill` (a pale tint of its final `headerFill`, e.g. ED `#eff6ff` under
`#bfdbfe`) plus a dashed `finalBorder` outline — never the neutral
`var(--bg-subtle)` grey, which reads as the AI-suggestion wash. The descriptor
grid (`RubricDescriptorGrid`) takes a `levelDraftColors` prop so it matches the
inline-table path. A draft is a tentative version of *this* score, so it should
look like a lighter shade of the final colour, not a separate neutral state.

## Outbound "View in Schoology" link — `SchoologyLink` (June 2026, #76)

A shared affordance for jumping out to a Schoology page (currently an
assignment's public `web_url`). Component:
`client/src/components/SchoologyLink.jsx`. Reuse it rather than re-inlining an
external-link anchor.

- **Glyph.** The Feather **external-link** SVG (box + out-arrow), `fill: none`,
  `stroke: currentColor`, `strokeWidth 2` — so it inherits the `.link` colour and
  tracks the active theme (no hardcoded hex, per the theming rule). It matches the
  inline-SVG idiom already used for the header's Refresh icon.
- **Two forms, one component.** A **labelled** form (icon + "View in Schoology"
  text) is used where the link stands alone and prominent — the **top of the
  `/assessment/` page** (issue ask: a clear way in). An **icon-only** form sits
  *beside* an assignment title where the title is already the primary link — the
  gradebook **Assessments list** (and, until #120, the submission-detail modal —
  see "Student work link" below). Icon-only links
  carry their name on `aria-label` (`View "{title}" in Schoology`); the SVG is
  `aria-hidden` so it never doubles the accessible name.
- **Safe + conditional.** Always `target="_blank" rel="noopener noreferrer"`
  (the standard safe external-link combo). Schoology omits `web_url` on some
  assignments, so `SchoologyLink` renders **nothing** when `url` is falsy —
  callers pass `web_url` through unconditionally.
- **Rotated-header placement.** The gradebook grid's **diagonal column titles**
  (`GradebookView`) are rotated −45° and ellipsis-clipped — an inline icon would
  fight the rotation and get cut off. So the icon is pinned **non-rotated at the
  column's bottom-centre** (`position: absolute; bottom; left: 50%`), forming a
  tidy horizontal band of links just above the "Assessment Type" row, one per
  column. General rule: when a label is rotated/clipped, attach the affordance to
  the column at a fixed, upright anchor rather than inline in the rotated text.
  - **No z-index on the icon:** it must stay *below* the sticky Student column
    (`z-index: 1`) so it clips behind it on horizontal scroll, exactly like the
    rotated title text — an elevated z-index makes scrolled-under icons leak over
    the frozen first column.
  - **Trailing spacer column.** The last title has no neighbour to overflow onto,
    so it spilled past the table edge onto the white card bg. A trailing spacer
    `<col>` (~250px, wider than the rotated title box) plus a spacer `<th>` per
    header row extends the header backdrop across that overflow; body rows leave
    it empty so the body keeps its own background. Rule: a rotated/overflowing
    header needs a trailing gutter the width of its overflow, carrying the header
    background.
- **Surfaces:** labelled at the top of the `/assessment/` page; icon-only beside
  the title in the gradebook Assessments list, the gradebook grid header band,
  and the submission-detail modal.

### Domain: links resolve on the school's Schoology host

Schoology's API returns `web_url` on the generic **`app.schoology.com`** host
(two path shapes: `/assignments/{id}/info` and `/assignment/{id}`), which doesn't
resolve to an SSO school tenant. The captured value is stored raw, and the
**server rewrites the scheme+host onto the configured school web domain** at serve
time (`server/lib/schoologyWebUrl.js`, host-only swap so both path shapes survive;
domain from `config.yaml` → `schoology.webBaseUrl`, default `https://schoology.hkis.edu.hk`).
Serve-time (not capture-time) keeps it config-live and fixes already-synced rows
without a re-sync; the DB keeps the raw verified API value.

## Gradebook: "submission status unavailable" vs. unknown (#76 follow-up)

OneDrive (`lti_submission`) submission state is read best-effort, per assignment,
from a browser-session document fetch that can transiently fail (all-or-nothing
for the whole assignment). When it fails, Prism has **no** submission status — a
state that must not be confused with a real one.

- **Don't dress up "unknown" as a grading state.** The earlier behaviour rendered
  an unknown overdue cell as a `·` dot labelled **"Ungraded"** — misleading, since
  *every* unscored cell is ungraded and the cell's actual gap is *submission*, not
  grading. That dot is gone; a cell with no captured state and no recorded failure
  renders blank (`—`), claiming nothing.
- **Flag a genuine *failure*, keyed on a persisted outcome — not inferred.** The
  sync records each assignment's fetch result in `assignments.lti_fetch_status`
  (`'ok'` | `'failed'`; `NULL` = non-lti / never attempted), retrying once before
  recording `'failed'`. Only `'failed'` raises a warning, so windowed-out/old work
  (left untouched) never false-flags, and a good full sync self-clears a stale
  flag. Rule: when a signal is *missing because capture failed*, persist that fact
  at capture time rather than guessing from absence at render time.
- **Cell-level amber `⚠`, with a re-sync affordance.** A failed assignment shows
  an amber `⚠` (`.lti-unavailable`, `var(--warning)`, `cursor: help`) on **every**
  ungraded, non-excepted cell — so a whole-assignment failure is impossible to
  miss — while graded/excepted cells stay clean. Hover reuses the shared grid
  popover (`setPopover`) to explain and point at re-sync (and `mastery:login` if
  the session expired). The marker carries its name on `aria-label`
  ("Submission status unavailable"). Failure granularity is the assignment, but we
  render per-cell for visibility, not as a column-header badge. Rule: surface a
  data-capture failure where the missing data would have been, with an action, not
  a dead end.

## Reviewer notes block — colour-coded AI sub-blocks (June 2026, branch `feat/suggested-feedback-block`)

The `/assessment/` card's AI output is one **neutral master tray** ("Reviewer
notes", muted `AiSparkle` label, white `--card-bg` + hairline `--border`) sitting
between the rubric grid and the Overall Comment. It replaces two earlier, separated
pieces — the collapsed reviewer-flags `<details>` at the top of the card and the
violet narrative box at the bottom — and groups three **colour-coded sub-blocks**,
each colour standing for a *function* so the hierarchy reads at a glance.

- **Collapsible, persistent, auto-tucking.** The whole tray collapses to a compact
  bar via a `▾ Hide` control; the bar carries a **prominent amber `⚑ Flag` chip when
  reviewer flags exist** (plus an amber tint) so a flagged student stays easy to spot
  while scrolling. Expanded by default; a deliberate collapse **persists per
  student+assignment in `localStorage`** (`prism:reviewer-notes-collapsed:…`), and
  the block **auto-collapses once the grade is published** (single or bulk) — the
  notes have done their job, so they get out of the way. (Flag *presence* is already
  per-student in the page data via `feedback_parsed.reviewer_flags`, so a future
  "has flags" roster filter needs no backend work.)
- **Neutral master, coloured children.** The tray itself is white so the amber and
  violet sub-blocks are the only colour and the expanded analysis reads as genuine
  black-on-white. A faint-grey tray was rejected because it would tint that "white"
  away. Drop the hairline border if it ever reads as box-in-a-box.
- **Reviewer flags — amber QA sub-block, uncollapsed.** Flags (when present) render
  expanded at the top; QA signal the teacher should see without a click. The old
  top-of-card collapsed `<details>` is gone.
- **Expandable seam, two columns.** `strengths`/`suggestions` (`feedback_json`,
  distinct from `reviewer_flags` and `narrative_feedback`) are teacher-facing
  analysis, hidden by default behind a **centred `▾ Show full analysis` toggle
  flanked by two rules** — a seam that visibly "opens". It expands *in place,
  between the flags and the narrative*, as **two side-by-side columns** — Strengths
  (green `+` markers) left, Suggestions (red `−`) right, scannable at a glance —
  black-on-white, **closed off by a second rule below** so it reads as a fully
  opened seam. The seam is omitted entirely when both arrays are empty — no
  affordance that reveals nothing.
- **Narrative — the publishable suggestion, scoped action inside.** The
  "Suggested feedback" narrative sits in a violet box reusing the AI-suggest accent
  (`--ai-suggest-wash` fill + `--ai-suggest` border) with **black body text**, just
  like the rubric's suggested cells. Its **`↓ Use suggestion`** button lives *inside
  this box* (solid `--ai-suggest` fill + white text, so it stands out against the
  wash it sits on) — making it obvious the action applies to this text; it copies
  the narrative *down* into the Overall Comment below.
- **Match the size of what it becomes.** The narrative, flags and strengths/
  suggestions items all render at **0.84rem**, the same size as the Overall Comment
  textarea — the suggested comment is previewed at the size it will publish at. The
  class-level **Reviewer Analysis drawer** prose (noticings + moderation note) was
  bumped to the same 0.84rem for readability; its distribution chart stays compact.
  The moderation note is titled **⚖️ Moderation note** (the icon alone was unclear)
  and rendered as a **dot-point list** — the grader emits one point per line, Prism
  splits on newlines and strips a leading bullet marker rather than guessing
  sentence breaks (single-line legacy notes degrade to one bullet).
- **Block visibility:** the tray renders when any of narrative / flags / strengths /
  suggestions is present, so a flags-only row still shows its flags now that they no
  longer have an independent top-of-card home.

## Assessment summary page: submission-status pill + filter row (June 2026, branch `feat/assessment-submission-status-pill-filters`)

- Each student card header shows a **prominent submission-status pill** computed
  from the same `gradeLabel.submissionStatus` rule (and colours / due-date
  proximity) as the gradebook grid, so the two never drift. A failed LTI fetch
  surfaces the same amber "status unavailable — re-sync" affordance as the
  gradebook cell.
- Below the header button row, a **grouped filter row** of themed toggle pills
  (mirroring the Summative / Formative `TypeFilterToggle`): submission status
  (3 pills for LTI / *Submitted* + *Unsubmitted* for non-LTI), grading completeness
  (*Ungraded / Partially graded / Graded*), visibility (*Visible / Not visible*),
  *Ask to resubmit*. Semantics: **OR within a group, AND
  across groups**; selection is in-memory (resets each visit, like the
  Summative/Formative toggles). Status-pill colour follows the assignment's
  due-date proximity, so the pills shift as a deadline nears/passes.
- The same submission / grading / flag state is exposed to the MCP for the
  grading agent: per-student `submission_status` + `grading_state` + `flags` on
  `get_assignment_context`, and `submission_counts` + `grading_counts` on
  `list_assignments` — so the agent can tell who actually submitted (vs. who only
  *looks* ready in the synced folder) before grading.

## Roster: dropped students behind a disclosure toggle (August 2026, #128)

- Students who have left a course are **hidden from the roster by default but never
  silently removed**. When any exist, a `.ghost` button sits above the table reading
  **"N dropped — show"** (toggling to "— hide", with `aria-expanded`). This is the
  general pattern for *soft-deleted rows the teacher may still care about*: keep the
  default view clean, but always show a **count**, so a disappearance is announced
  rather than inferred from a roster that quietly shrank.
- Revealed rows are **sorted to the bottom** of the table, rendered at `opacity: 0.55`,
  and annotated in the name cell with a muted `dropped DD/MM/YYYY`
  (`toLocaleDateString('en-GB')` — never US M/D/YYYY). Greying rather than
  strikethrough: the student's grades and notes are still live and clickable, they're
  just no longer in the class.
- The API supports this in one request — `GET /api/courses/:id/students?includeDropped=true`
  returns both groups, each row carrying `dropped_at` (null for active). The client
  splits on that field, so the toggle costs no extra round-trip and the count is
  always accurate. The unparameterised endpoint stays active-only, so other consumers
  can't accidentally reintroduce dropped students.
- Counts are kept **separate, not merged**: `GET /api/courses/:id` returns
  `studentCount` (active) alongside `droppedCount`. Anywhere a single number is shown
  ("10 students"), it means *currently enrolled*.
- **On the cards (#160, 25/10/2026):** the Roster tab keeps the pattern as a `.ghost`
  button reading **"N dropped (show)"** / **"N dropped (hide)"** (`aria-expanded`) under
  the cards. Revealed cards come last, at `opacity: 0.55` (`.roster-card--dropped`),
  with "dropped DD/MM/YYYY" under the name. A dropped student is never counted, never
  copied by Copy emails, never in Needs attention or Test day, and shows no private slot.

## Dashboard: semester grouping on both tabs (August 2026)

- The **Current** tab now groups its course cards by semester, matching the Archived
  tab's second-level grouping. Headings use the shared `.semester-subhead` class
  (renamed from `.archived-semester-subhead`, since it's no longer archive-specific).
- Only the Archived tab carries an academic-year heading above the semester
  subheads — current courses are all in the running year, so a year label there
  would be redundant chrome. `groupBySemester()` (semester only) and
  `groupByYearAndSemester()` (year → semester) in `client/src/lib/courseDisplay.js`
  share one `SEMESTER_ORDER` so the two tabs can never drift apart.
- Canonical semester order is **Full Year → Semester 1 → Semester 2 → Summer →
  Unknown**. Full Year leads because it *spans* the terms below it (a teacher's
  year-long courses are the standing context), then the terms run in calendar
  order. This order also drives the sync dialog's archived-course discovery list.
- Current-tab cards stay at full opacity with no per-card grading-period line;
  the archived cards keep their dimmed (0.75) treatment and period text, so
  "archived" still reads at a glance without a badge.

## Dashboard: enrolment count on course cards (August 2026)

- Every course card carries a muted `.badge-gray` reading **"N students"**, placed
  as the **first item in the card's bottom-left badge group** — the same row that
  holds the red `Hidden` badge, so adding it shifts nothing vertically and the ⚙
  stays anchored right. Grey, not a coloured badge: the count is *metadata*, and
  a saturated chip next to `Hidden` would read as a status alert.
- The badge is **omitted entirely when the count is 0 or absent**, rather than
  rendering "0 students". Empty shells (the master/template course) are the case
  this protects — the list endpoint carries `student_count` precisely so callers
  can spot them, and a zero badge is noise on a card the teacher never opens.
- Wording matches the CoursePage header's `${course.studentCount} students`, and
  singularises to **"1 student"**. Both surfaces count *active enrolments only*
  (`dropped_at IS NULL`), consistent with "anywhere a single number is shown, it
  means currently enrolled" from the dropped-students entry above.
- Shown on **both tabs**. Archived cards are already dimmed to 0.75, which carries
  the badge with them, so "archived" still reads at a glance while the roster size
  stays visible for past-year courses.

## Tab and filter state survives navigation (August 2026)

- **Every tab bar / filter selector remembers itself.** Dashboard (Current /
  Archived), CoursePage (Roster / Gradebook / Assessments / Analytics),
  FeedbackPage's status filter (page retired in #122), and AssessmentSummaryPage's Descriptors /
  Compact toggle all go through `client/src/hooks/useStickyTab.js`. Previously
  each held plain `useState`, so React Router unmounting the page on navigation
  reset it — clicking from Gradebook into an assessment and pressing Back landed
  you on Roster.
- **The active tab lives in the URL** as a query param: `?tab=` for the two tab
  bars, `?status=` on Feedback, `?view=` on the assessment summary. This makes a
  tab **linkable and refresh-safe** ("here's the gradebook" is now a URL you can
  paste), and it is what the browser Back button restores — the page's history
  entry already carries the param.
- **Tab clicks `replace` the history entry rather than pushing one.** Otherwise
  Back would step backwards through every tab you tried instead of leaving the
  page.
- **A `sessionStorage` sidecar (`prism.tab.<key>`) covers the other way back.**
  In-app "← Back to course" links point at a bare path with no query string, so
  the URL alone can't restore the tab there. Reads prefer the URL and fall back
  to storage; writes update both. Storage access is wrapped in try/catch — a
  forgotten tab beats a page that crashes in Safari private mode.
- **Keys are per page-type, not per-course.** `course`, not `course-5`: pick
  Gradebook in one course and the next course you open also starts on Gradebook.
  A teacher moving between courses is usually doing the *same task*, so carrying
  the mode across is the helpful behaviour, and it keeps the key space small.
- An empty param is a real choice, not a missing one — `?status=` selects
  Feedback's "All", which is why the hook uses `??` (not `||`) between the URL
  value and the fallback.

## Class List tool — format pickers preview themselves (September 2026)

- **Each format option carries a worked example**: the Format dropdown reads
  `First Last — Alex Chen`, `Last, First — Chen, Alex`, `First L. — Alex C.`
  rather than the bare label. A teacher picking a name format is choosing a
  *shape*, and the label alone ("First L.") makes them generate the list to find
  out what it does. The sample (`SAMPLE_STUDENT` in
  `client/src/lib/nameFormats.js`) deliberately has three different given names —
  legal `Alexander`, Schoology-preferred `Al`, teacher override `Alex` — so
  `Legal first + Last` visibly differs from the rest instead of looking redundant.
- **Formatting is client-side; the fetch is not.** `GET /api/tools/roster/:ids`
  returns raw name fields and the card renders them through
  `formatClassList()`. Changing format, separator or sort order is instant and
  costs no round trip — which matters because trying formats is exactly how a
  teacher decides which one they want. The server stays the single source of
  *who* is enrolled; the client owns *how they read*.
- **Sorting always keys off the displayed (preferred) given name**, whatever
  format is selected — including `Legal first + Last`. Order on screen should
  match the order the names read in, top to bottom.
- **Changing the course selection clears a generated list** rather than leaving
  stale names above freshly-ticked boxes. The sibling tools on this page don't
  do this yet; when one of them is next touched, it should.
- **An empty roster says so** (`.alert.alert-warning`) instead of rendering an
  empty textarea, which reads as a broken button.

## Version badge — the sidebar names the backend (September 2026)

- **The badge reports what `/api` answered, not what the page was built from.**
  A short SHA means a deployed release; `dev` means a clone with no
  `release.json`. This is deliberate: when a local Vite client proxies `/api`
  at the server, the only question worth answering is which backend is
  serving the data, and a build-time constant baked into the bundle would
  answer the wrong one.
- **Quiet by default, legible on hover** — `opacity: 0.55` rising to `0.9`,
  monospace, 0.7rem, `var(--sidebar-text)`. It is reference information, not
  navigation, and should never compete with the nav links above it.
- **It renders nothing when the request fails.** A server that cannot be
  reached already shows itself everywhere else in the UI; an error chip in
  the sidebar would be noise on top of noise.
- **The build time is a `title`, in `en-GB`** — `Built 23/09/2026 09:06`.

## Logo & favicon — Prism's identity (September 2026)

- **The idea: separate streams in, one unified source out.** Three coloured
  beams (Schoology, PowerSchool, the teacher's own notes) arrive at *very
  different angles*: blue falls, teal runs nearly level, violet rises. They
  pass straight through the prism's front face, bend at its centre ridge,
  converge on one point on the far face, and leave as a single beam, which
  becomes the wordmark's underline. The wide fan of angles carries the
  meaning, so the logo deliberately disobeys optics. **Visual balance beats
  physics here.**
- **The concept art is the source of truth**
  (`client/src/assets/prism-logo-colour.png`). The geometry in
  `client/src/lib/prismLogoGeometry.js` was measured from it, in the art's
  own pixels:
  - each beam's centre line and slope
  - thickness: 54 px at the left edge, 28 px at the ridge
  - the prism's apex and base
  - the underline's height and its extent
  - the wordmark's stem-to-edge run

  The SVG uses those pixels directly as its viewBox, so an overlay on the
  PNG lines up. Tests pin the composition: a wide fan, straight on entry, a
  bend at the ridge, one exit.
- **The bend happens at the ridge, not on entry.** The vertical ridge line (the
  prism's front edge, which makes it read as 3-D) is where each beam kinks
  downwards towards the exit. Without that line the bend has no reason and
  looks like a mistake. Keep it.
- **Tried and rejected on 27/09/2026: physically correct refraction.** Snell's
  law with an apex-up prism and a horizontal exit forces every beam to rise
  from below, which collapses the fan. It lost the symbolism and looked
  worse.
- **Kept from the art:**
  - each beam stops just short of the glass (a 14 px gap) and is paler
    inside it
  - the prism's right-hand face is shaded
  - the beams taper from the left edge to the ridge
- **Changed from the art:**
  - it is vector, on a transparent background
  - the wordmark is light (`--logo-text`), for the dark sidebar
  - the beam out starts 14 px clear of the far face, its end cut parallel
    to the face. This mirrors the gap on the way in, so it reads as leaving
    the glass. Starting it on the face laid it across the white edge.
- **Colours are variables.** The beams use `--brand-blue`, `--brand-teal` and
  `--brand-violet`, which don't change with the theme. The glass and the
  wordmark use `--logo-glass`, `--logo-glass-shade`, `--logo-glass-edge` and
  `--logo-text`, which default to light-on-dark. `--brand-ink` (#0b1733) is
  the art's navy, for use on light backgrounds.
- **The wordmark is live text**: Montserrat 600, with a larger cap "P" and caps
  "RISM". Montserrat is broader than the art's typeface, so the sizes are
  about 7% smaller and `textLength` pins the run to the art's width. The
  underline therefore ends exactly where the "M" ends. Screen readers hear
  "Prism" (`role="img"`), and `useId()` keeps two instances' ids apart.
- **The favicon is generated from the same geometry.**
  `node scripts/render-favicons.mjs` writes `client/public/favicon.svg` and
  renders `favicon-32.png` and a full-bleed 180×180 `apple-touch-icon.png`.
  - The favicon's square crop is **centred on the prism** (its bounding box),
    and the beams run off the tile's edges. An earlier crop was centred on
    the whole mark, which left the prism off to one side.
  - The favicon is a square crop of the mark, with beams 1.5× heavier and a
    heavier outline so it survives 16px. It sits on a rounded tile in the
    Prism theme's sidebar purple (`#2d1b69` → `#1e1145`).
  - The favicon's exit beam is **white tinted towards cosmic cobalt**
    (`#c8cbff`), meaning all the colours combined. A solid cobalt beam on a
    light tile was tried on 27/09/2026 and rejected: the dark purple tile
    with a light beam looked better.
    At 16–32px the logo's gradient is too short to read as a gradient. It
    is **finer than the three beams** going in, because it leaves after they
    converge: the light is focused. The favicon draws every beam 1.5×
    heavier, and the exit beam scales with them. A thicker exit beam was
    tried and rejected on 27/09/2026.
  - Its hex values live in the script, because a favicon can't see CSS
    variables.

## Phone layout — the shell adapts, pages don't yet (September 2026)

- **One breakpoint, one block.** Below 768px (so iPad portrait too) the fixed
  240px sidebar becomes a slide-in drawer, opened by a menu button in a thin
  top bar that repeats the logo. All phone rules live in the `PHONE LAYOUT`
  `@media` block at the end of `app.css`. Desktop has no top bar and no
  backdrop (`display: none`), so desktop rendering is unchanged: verified by
  pixel-diffing every page against `main` at 1440, 1024 and 800px.
- **The top bar uses the sidebar's own background**, so the light-on-dark logo
  works there without a second colour set, and the bar reads as the sidebar
  folded away.
- **The top bar scrolls away rather than sticking.** Pages already have their
  own sticky bars at `top: 0` (the assessment summary, the gradebook header);
  a sticky top bar would cover them.
- **The drawer closes on navigation, a backdrop tap, Escape, or Sync.** When
  closed it is `visibility: hidden` as well as off-screen, so its links leave
  the tab order. Visibility flips only after the slide finishes.
- **Wide tables scroll inside themselves** (`display: block; overflow-x:
  auto`) instead of widening the page. The gradebook is excluded: it already
  scrolls inside its card and depends on a sticky header and first column.
- **Tap targets are about 44px** in the drawer (links, Sync, theme dots) and
  the menu button. Tab and filter buttons get a smaller bump.
- **Form fields are 16px on phones**, because iOS zooms into any focused field
  under 16px.
- **Deferred: page-level layouts.** Pages keep their desktop layout at phone
  width. Their inline `style={{…}}` blocks can't be overridden by a media
  query, so adapting a page means moving its styles into classes first. The
  candidates are the quick-lookup pages (Dashboard, Student, Directory,
  Search). The grading-heavy pages (assessment summary, rubric manager,
  import, sync config) stay desktop tools. *Done for the quick-lookup pages in
  step 2 (#134), below.*

### Step 2: the quick-lookup pages (October 2026, #134)

- **Move only what must adapt.** On the Student, Search, Directory, Dashboard
  and roster pages (*the roster table was replaced by the Roster tab's cards on
  25 Oct 2026, #160, see "Roster tab: layout and container queries"*), just the inline styles a phone needs to change moved into
  classes (a `QUICK-LOOKUP PAGES` section of `app.css`), with the old inline
  values verbatim, so desktop is pixel-identical (diffed against `main` at
  1440, 1024 and 800px, including the note form open and in edit). The phone
  rules are in the `PHONE LAYOUT` block as before.
- **Secondary columns fold under the name.** A phone hides a table's secondary
  columns (`.col-desktop`: Email and Grade on Search, School in
  the Directory) and shows the same facts as one muted line under the name
  (`PersonSub`: `.person-sub.phone-only`, the parts joined by " · "). Search and
  the Directory then fit, so they stay real full-width tables
  (`table.fits-phone`) instead of sideways-scrolling boxes. (The course roster
  was a table with this folded line and a scrolling mastery box until #160
  replaced it with cards on 25/10/2026; see "Roster tab: layout and container
  queries".)
- **`.phone-only` / `.col-desktop`** are the general pair: `display: none` on
  desktop / on phones. A `display: none` element paints nothing, so adding
  phone-only markup cannot change desktop.
- **`.tap-target`** gives a small text or icon button a 44px hit area on phones
  (notes Edit/Delete, a guardian card's Edit, copy buttons, the Dashboard card cog). Where
  the bigger box would push lines apart (the copy button beside an email), a
  negative margin lets it overlap them instead.
- **Student page:** the photo drops from 144px to 88px, the name row wraps
  (name, grade badge, ID), long emails break instead of pushing the family
  contacts out of the card, and course sections use 1rem side padding. The note
  form stacks: the note full width, then the course picker full width, then
  Save and Cancel side by side at 44px. The "add note" pencil is a 44px target.
  (Flags are added on the assessment page, not here.)
- **Form fields stay 16px.** An inline `font-size` beats the shell's 16px phone
  rule, so the note course picker and the guardian's extra phone and email
  fields (`.parent-detail-input`) moved theirs into classes; `input[type="tel"]`
  joined the 16px list.
- **Tap for hover.** `HelpDot` also opens on a tap (click), and closes on blur
  or scroll (a fixed popover would otherwise float away from its dot). Its
  popover is clamped to stay on screen near either edge.
- **Dashboard "Show hidden"** toggles from its words as well as its track, and
  the track is a `role="switch"`.
- **Desktop tools say so.** The assessment page, the gradebook and analytics
  tabs and Import show one `LargerScreenNote` line ("Best on a larger screen.")
  at phone width only. They are not otherwise adapted.
- `npm run check:mobile` now fails if a quick-lookup page scrolls sideways, if
  Search or Directory tables overflow their card, if the student header
  overflows, or if the note form loses its full-width box or 44px buttons.

## Student work link — "Open" beside the status pill (September 2026, #120)

On the `/assessment/` page, each card for a OneDrive (`lti_submission`)
assignment shows a small **"Open"** link immediately after the
submission-status pill. It opens the student's own OneDrive copy, in progress
or submitted, in PowerPoint/Word Online.

- **Reuses `SchoologyLink`** (external-link glyph + label, new tab,
  `noopener noreferrer`), even though the target is SharePoint, not Schoology.
  The glyph means "leaves Prism"; one affordance for every outbound link keeps
  the language consistent. The component gained an optional `title`, and an
  explicit `ariaLabel` now overrides a visible label. Keep the visible label
  as the start of the accessible name ("Open" → "Open {student}'s work in
  OneDrive") so voice-control users can say what they see.
- **Beside the pill, not in the right-hand cluster.** The status pill answers
  "what state is their work in?"; the link answers "show me it". They belong
  together at the start of the card header. The right-hand cluster is for
  Prism actions (flags, resubmit).
- **Short label, detail on hover.** The link says only "Open". The tooltip
  adds the last-edited time (`formatDateTime`, day-first), which tells you at
  a glance whether an in-progress student has touched the file recently.
- **Nothing rather than a dead link.** A card with no matched file shows no
  link. The lookup runs after the page loads because it takes a few seconds,
  so the header shows a muted "Finding OneDrive files…" while it runs and
  "OneDrive links unavailable" (with a tooltip on how to fix it) if it fails.
  It never shows a per-card error.
- **Google Drive tasks (October 2026, #142):** the same "Open" link, in the
  same place, on the card and in the gradebook modal. The accessible name and
  tooltip name the store ("Open {student}'s work in Google Drive: submitted
  {date}"), so the one label works for both apps. Drive links show only once
  the student has submitted. The header's loading note became the neutral
  "Finding students' files…", because the app isn't known until the lookup
  answers. The failure note names whichever store failed. Wording lives in
  `client/src/lib/workLink.js`.

**Gradebook submission modal (September 2026, #120).** The modal is about one
student's work, so its outbound link is that student's own file: the same
"Open" link, placed after the submission badges. It **replaces** the
assignment's Schoology link that sat beside the modal title (#76). That link
stays on the gradebook column header, which is the assignment-level place for
it. The modal fetches the assignment's links when it opens (instant within the
5-minute server cache) and shows nothing while loading or when the student has
no file.

## Level order: best on the left (September 2026, #41)

Every grading scale renders its levels **best → worst, left → right**. That
holds for the General Academic Scale (ED | EX | D | EM | IE, as the rubric
already did), Completion (**Completed | Incomplete**) and Approaches to
Learning (**Consistent | Inconsistent | Seldom**). Config lists levels in that
order (`config.yaml` `grading.scoreScales`), and components render them in the
order given. Never sort them.

**Score-scale picker (`ScaleLevelPicker`).** An unaligned assignment graded on
one of those plain scales gets a single row of level buttons in place of the
topic rubric. It follows the rubric's visual states: the synced grade is a
filled cell with a solid border; a pending choice is a light fill with a dashed
border. Descriptor text shows under the label when the scale has any (GAS
does). Colours come from the shared 5-level palette: GAS codes keep their own
colour, and other scales map by rank (best green, middle yellow, worst red), so
"good" reads the same everywhere. The Descriptors/Compact toggle is hidden on
these pages because there is nothing to switch.

**Class-bar "Mark all Completed".** A bulk *staging* action, not a write. It
uses the same two-click confirm as Discard all ("Click again to mark all
Completed"). It only touches shown students with no grade, no pending choice
and no locking exception, then reports how many it marked. Publishing is still
the teacher's separate "Publish all" step.

**Agent scale suggestions (September 2026, #41).** A PrisMCP `scale_level`
suggestion uses the same violet language as rubric suggestions. The level
button gets a `var(--ai-suggest)` ring and a `✦ Suggested` tag. The agent's
evidence note sits under the row as `✦ Suggested <level>: <evidence>`, so you
can see *why* before accepting. The class bar's `✦ Accept all suggestions (N)`
is outlined violet to match. Like "Mark all Completed", it only stages;
publishing stays the teacher's step. The suggestion ring coexists with the
synced and pending states, so "agent agrees with the current grade" is visible
at a glance.

## Naming the class: block first (September 2026)

A Schoology section name like "4(A-B)" reads like a block number but isn't one
(AP CSP 4(A-B) is block 7). So wherever Prism names a class, the **block**
leads:

- **`/assessment/` breadcrumb:** "← [BK 7] AP COMPUTER SCIENCE PRINCIPLES"
  replaces "← Back to course". It reuses the Dashboard card's `[BK n]` label,
  so the class reads the same on both pages.
- **Course page meta line:** "Block 7 · 4(A-B) · 19 students · …", with the
  block ahead of the section.

## Reviewer notes: glance first, detail on demand (September 2026)

In practice the long flag paragraphs went unread, while the short
Strengths/Suggestions lists were quick to judge. So the expanded notes now read
top to bottom:

1. **⚑ Reviewer flags as short bullet lines.** These are the agent's
   `reviewer_flags_brief`, or else the first sentence of each flag paragraph,
   trimmed at ~140 characters with "…".
2. **Strengths / Suggestions**, shown by default (they used to be hidden).
3. **"▾ Show detailed flags"**, the full flag text in the same amber, behind
   the centred seam toggle. It's offered only when the full text says more
   than the bullets.
4. **Suggested feedback.**

**"Use suggestion" folds the box.** After use it becomes a dashed one-line
"✓ Suggestion used, now in your comment below · ▸ Show again". That signals the
text now lives in the comment, so you don't read it twice. The used state is
stored per suggestion text, so an agent's **revised** suggestion shows in full
again, tagged **✦ Revised**. The whole notes block works the same way: its
collapsed state remembers *which* notes were collapsed, so new notes from an
agent re-run reopen it on their own.

**"Ignore" beside "Use suggestion" (October 2026).** The suggested-feedback box
has two actions: **Ignore** (outlined violet, on the left) and **↓ Use
suggestion** (solid, on the right). Both fold the box to a dashed one-liner,
"Suggestion ignored" or "✓ Suggestion used, now in your comment below", with
**▸ Show again**, so an ignored suggestion is still one click from use. The
state lives on the server (`feedback.suggestion_state`), so it holds across
devices. Only an agent re-run that *changes* the narrative resets it, to
`revised`, which shows the box again tagged **✦ Revised**.

## The AI mark: one rounded four-point star (October 2026)

`AiSparkle` is a **single four-point star with curved sides and rounded tips**
(Gemini-like): one filled path, softened by a round-joined stroke in the same
`currentColor`. It replaced the 3-star `ai-sparkle.svg` glyph (June 2026), at
the teacher's request, going back to the single star used before that. It's
also used in place of the `✦` text character, so every AI-suggestion marker
(rubric cells, the Reviewer notes header, Reviewer Analysis, "Suggested"
tags, "Revised", "Accept all suggestions") is the same icon. Colour is always
`var(--ai-suggest)` (white on the solid "Revised" badge).

**Corner marks float, they don't overlay (October 2026).** In
`RubricDescriptorGrid`, the AI star and the red staged-removal "×" sit in the
cell's top-right corner as a **float**, placed before the descriptor text. The
first line wraps around the mark and the lines below keep the full width.
Previously they were `position: absolute` on top of the text, which hid words
on the first line. Use the same pattern for any future corner badge on a text
cell.

## Urgency ring (triage) — 2026-10-01, ring since 2026-10-02

Used by the Dashboard / course-page triage panels (make-up tests, late work, feedback owed) and the
Assessments tab wait column. `UrgencyRing` is a 40px SVG ring (`size` prop; 28px in the triage rail,
40px kept on the Assessments tab) (4px stroke, track `var(--border)` —
not `--bg-subtle`, which equals `--card-bg` in midnight and would vanish) whose arc fills
`min(1, day / limit)` of the circle, with a 4% floor so a short arc still shows its colour. The arc
takes its colour from a tone computed on the server (`toneFor`): `--success` early, `--warning` over
the last `warnLead` allowed days, `--danger` after the limit. The **day number** sits centred inside
(amber/red use `--badge-amber-text` / `--badge-red-text`), so the colour is never the only signal;
`role="img"` + "day D, limit day L" names it.

**Day numbering — the due date is day 1 (2026-10-02).** Every triage clock is shown as a school-day
*number* counted from its start date as day 1 (due date, extended date, test date, the wait's start),
not as "days since": the teacher reads "due on day 1, submit through day 8, referred on day 9" more
easily than "8 days late". `limit` is the **last allowed day** (late work 8, feedback 10; make-ups sit
by day `makeUpRedDay − 1`), so a ring reads amber "8" on the last day and red "9" the day after; the
late-work action says "N left" (`limit − day`) and "last day" on day `limit`. Subtitles state the rule
("due date = day 1 · refer after day 8"), Dashboard chips say "7 to grade · day 9", and Settings
labels are day numbers ("Late work is allowed through day [8]", since replaced). Display only: the server keeps its
`schoolDaysBetween` counts for the tones, so who is flagged and when did not change. Reuse this
numbering for any future school-day clock. `≈` (with a tooltip) marks
counts from the weekday fallback (no PowerSchool calendar).

**Stacked rows** *(superseded 2026-10-02 by the compact rows of "Triage rail" below)*. Each `.triage-row` is `ring | stacked text | actions`. The text column stacks the
primary link (student name, or the assessment title on feedback rows), then the course label
(`.triage-row__course`: small, bold, accent, one line with an ellipsis and the full label as its
`title`; all-courses view only), then the task title with its tags ("submitted day N",
"ext +N → date"). Actions group at the right as compact buttons (`button.btn-sm`): Mark referred
`.primary`, Extend / Ignore this test `.secondary` (bordered), "N left" / "last day" muted text before Extend;
feedback rows show "X of Y ungraded" there instead. On phones the ring stays left and the actions
wrap to their own line, indented to align with the text. The Referred / extended history uses the
same stacked text without a ring. The Assessments tab wait column is the ring plus "x/y ungraded".
History: a thin horizontal bar (`.urgency-meter`) with the count beside it, 2026-10-01; replaced by
the ring and stacked rows 2026-10-02.

**Inline row editor — Extend (2026-10-02).** Every late-work row has an **Extend** button that
replaces the row's actions with an editor on its own full-width line below the text (`.triage-row__editor`): a `NumberStepper` (lessons, 1–60, default 3), a note input
(`.triage-note`) and Save / Cancel — no modal. An extended row carries a grey tag
"ext +N → DD/MM/YYYY". Reuse this open-below-the-row pattern for any other small per-row edit.

**Make-up tests panel (2026-10-02).** The "Make-up tests" panel sat **full-width above** the
late-work / feedback-owed grid (now first in the triage rail, below) (most urgent first: a missed test can be invalidated), using the same
stacked `.triage-row`, urgency ring and shared `ExtendEditor`. A whole-test action ("Ignore this test")
opens an inline confirm below the row ("Ignore <title> for all students?" Yes / Cancel) rather
than a modal. On the Assessments tab a per-test setting is a click-to-flip badge button
(`.makeup-chip`, "Make-ups: tracked / ignored", `aria-pressed`).

## Triage rail — compact rows, 5 + "All N", logo home (2026-10-02)

**Rail.** The triage panels stack in a right-hand **rail** (`<aside class="triage-rail"
aria-label="Triage">`, 380px) beside the page's main column (`.triage-layout` →
`.triage-layout__main` + rail): Make-up tests, Overdue work, Feedback owed (since joined by Unfinished
grading, Resubmissions and Flags (#174), ordered by their most urgent row, `orderPanels`). On the Dashboard (Current
tab) the main column is the course cards, two per row (`.grid-2` becomes `auto-fill,
minmax(min(260px, 100%), 1fr)` there, so it drops to one column when narrow — no new breakpoint; the PHONE LAYOUT block restates the one-column rule for it so phones stay governed there).
On a course page the rail sits beside every tab's content **except Gradebook**, which needs the
width: there the rail is hidden (`hidden`, still mounted, so Show formative / open rows / the fetch
survive) and a `Triage ▸` button (`.secondary.btn-sm`, red badge = red rows across the three lists,
`aria-expanded` / `aria-controls`) at the right of the tab row toggles it back in beside the
gradebook ("Hide triage" to remove it). Toggle-in rather than an overlay drawer: no focus trap,
scrim or z-index stacking against the gradebook's sticky headers, and the same layout as every other
tab. On desktop the rail is `position: sticky` (top 1rem) and scrolls inside itself
(`max-height: 100vh − 2rem`) when taller than the window, so a long rail never strands its bottom
panel. On phones (PHONE LAYOUT block) it is one column: the rail follows the main column, full
width, not sticky.

**Compact rows.** `.triage-row` is a grid: 28px ring | text | a stacked action column, with the
editor/confirm area spanning under text + actions when open. Each text line is one line with an
ellipsis and the full text as its `title`: late / make-up rows = name / course label (Dashboard
only) / assessment; feedback rows = assessment / course label. Tags that must never truncate sit
**beside the name** on line 1 (`flex-shrink: 0`): "submitted day N", "ext +N → DD/MM/YYYY", the
formative "F". Feedback rows show the count right-aligned as "X/Y" (title "X of Y ungraded"), and
have no row actions. Red late rows keep an inline primary **Refer** (visible name "Refer",
`title="Mark referred"` — the accessible name matches the visible text). Names and feedback titles
are links without an underline (underline on hover) — the earlier always-underlined feedback title
read as noise in the dense rail. Dashboard course-card titles drop to 0.95rem beside the rail so
two cards fit per row.

**Stacked row actions, no expand toggle (2026-10-02).** *(supersedes the ▾/▴
`button.triage-row__toggle` described above, the same day it shipped — a teacher on a phone found
revealing Extend behind an expand step one tap too many.)* `.triage-row__actions` is a `flex`
**column** (`align-items: stretch`, 0.3rem gap): it auto-sizes to its widest child and stretches
the rest to match, so stacked buttons share one width with no fixed sizing — same column, same
behaviour, at every rail width, not just on phones. Overdue work stacks **Refer** above **Extend** on
a red row, or the muted "N left" / "last day" label above **Extend** otherwise (Refer never
repeats once a row has it inline). Make-up tests stacks **Extend** above **Ignore this test**
(still its quiet bordered `.secondary.triage-row__quiet` style). The whole column sits vertically
centred against the row's text via the row's own `align-items: center`. Clicking **Extend** opens
the shared `ExtendEditor` full-width below the row (`.triage-row__more`, `grid-column: 2 / -1`) —
the same spot the old expanded area used — without hiding the action buttons; clicking **Ignore
this test** opens its inline confirm there instead. Only one editor/confirm is open per row
(opening either closes the other); Cancel closes it. The Referred / extended history keeps the old
horizontal `.triage-row__actions` (badge + date + Undo, wrapping) via an explicit
`.triage-row--history .triage-row__actions { flex-direction: row; }` override — it never had an
expand toggle and isn't part of this change.

**Row actions respond to the panel, not the viewport (2026-10-02, later the same day).**
*(Refines the paragraph above: the always-column `.triage-row__actions` only noticed later that it
stacked buttons even in a wide rail with room for them side by side.)* `.triage-row__actions` is now
row-by-default (`display: flex; flex-direction: row`) — Refer | Extend, "N left" | Extend, Extend |
Ignore this test, side by side — and only stacks into the column described above once its own
`.triage-panel` narrows below `32rem`. That's a **CSS container query**
(`@container triage-panel (max-width: 32rem) { .triage-row__actions { flex-direction: column; … } } `),
keyed off `container-type: inline-size` set on `.triage-panel`, not a viewport `@media` query — the
rail panel can be narrow on a wide desktop window (380px rail) or wide once it drops full-width on a
phone, so viewport width is the wrong signal entirely. **Container queries are a different mechanism
from the PHONE LAYOUT `@media (max-width: 768px)` block and must not be added there** — they need to
keep responding to the panel's own size at every viewport, phone included. jsdom can't evaluate
container queries, so this is verified by eye (and noted here), not by a unit test; the existing
DOM-order/structure tests are untouched since no markup changed, only the CSS driving the layout.

**5 rows, toggle at the top.** Each panel shows its 5 most urgent rows (server order). Longer lists
get an `All N ▾` / `Fewer ▴` button (`.ghost.accent`) in the panel **header**, right side (before
the Formative checkbox on Feedback) — at the top so the teacher never scrolls to find it. Per panel,
remembered for the session (`sessionStorage` `prism.triage.showAll.<panel>.<all|courseId>`). Badges
("N overdue", "N to refer") always count the full list. Subtitles are short rules ("due date = day 1
· refer after day 8"); the Referred / extended history link stays at the bottom of Overdue work. Reuse
the header-toggle + per-row ▾ pattern for any other dense side list.

**Logo = home.** The sidebar logo (still the `h1`) and the phone top-bar logo are `Link to="/"`
(named "Prism" by the logo SVG); clicking closes the phone drawer like any nav link.

## Sync that survives a dropped connection + Recent syncs log (2026-10-02, branch `feat/sync-resilience-logs`)

**Why.** The teacher synced from an iPhone and saw "several consecutive sync errors" while the server
log showed both syncs finished cleanly. iOS kills the Sync dialog's long streaming request when the
screen locks; the dialog reported that as a sync failure, and tapping Sync again hit "already in
progress" — a second false error.

**Connection lost is a notice, not an error.** When the stream drops but the server has given the
dialog a run id, the dialog shows a **muted italic status line** under the heading
(`.sync-notice`, `role="status"`, `--text-muted`): *"Connection lost — still syncing on the server…"*.
It then follows the run by polling and ends in the normal done state. A dropped connection is never
shown in `--error` or as an `.alert`. The same line reads *"A sync is already running — showing its
progress."* when the dialog joins a run it didn't start (409, or Sync opened mid-run on another
device or after a reload). The joined view loads the run's earlier lines, so the log looks the same
on every device. Returning to the page polls straight away, without a notice, because the switch is
routine. **The dialog can be closed while it follows a sync** (a secondary **Close** in the footer; the
sub-line says "You can close this or lock your screen — the sync keeps running on the server"), and
reopening Sync joins the run again. Closing aborts the stream; the server keeps going. Errors appear
only when the server reports one (e.g. the run was `interrupted` by a restart). **Losing touch with
Prism is not an error either:** after ~3 minutes of failed polls, counted in *visible* time only and
restarted on every return to the page (an unlocking iPhone's VPN/Wi-Fi, a deploy's 502s), the dialog
goes into a neutral **stalled** state. The heading is "Can't reach Prism" in `--warning` and the
`.alert.alert-warning` reads "Couldn't reach Prism — the sync may still be running. Check Settings →
Recent syncs.", with **Try again** (resume following) and **Close**. A raw fetch error ("Load
failed") is never shown.

**Recent syncs card (Settings).** One `.card.settings-section` with a `.ghost.accent` Refresh in the
header. It lists up to 60 runs: the last 30 full syncs and the last 30 task and quiz runs (#170). Each run is a full-width `.ghost` row button (`aria-expanded`): **start date/time** (bold,
tabular, `formatDateTime` en-GB) → **status badge** from the existing badge palette (green Completed,
amber "Completed with N errors", red Failed, gray Interrupted, blue Running…) → right-aligned muted
meta: duration, what was synced ("Schoology · blocks · 2 mastery courses"), and counts ("1 error · 3
warnings", `--danger` if any errors, otherwise `--warning`). Tapping a row expands its log inline (`aria-expanded` + `aria-controls` → the log region).
Refresh reloads the list and any open log. An open log of a running sync re-fetches every ~3s and
reloads the list when the run ends. An interrupted run's duration ends at its last event, and
durations over an hour read "1h 12m". The log
reuses the sync dialog's `.sync-log` look (monospace, `--table-header-bg`, bordered) and scrolls inside
the card (max 320px; 60vh on phone). Each line has a muted `HH:MM:SS` time, the same ✓ / ✕ / ● phase icons
as the dialog, and readable text ("Mastery · Bio — 412 records"). **Error lines** are `--danger` bold
on `--error-light`; **warning lines** are `--warning`. The error/warning rule lives on the server
(`classifyEvent`), and every event arrives with its `level`, so the UI never re-derives it. On phone
(PHONE LAYOUT block) the meta drops onto its own line under date + badge. Screenshots:
`/tmp/sr-recent-syncs-{desktop,phone}.png` at build time.

## Resubmissions panel (2026-10-03)

A 4th triage panel, same `.card.triage-panel` + `UrgencyRing` + stacked `.triage-row` family as the
other three (see "Triage rail" above), with its own vocabulary for the two resubmission states.
**Hidden on a fresh load when empty** — no "0 resubmissions" placeholder — but once it has shown rows
during the current mount it **stays mounted after the list empties** (e.g. the teacher just acted on
the last row), showing "All caught up." plus the History link, so the record just made (and its Undo)
stays reachable instead of the panel vanishing out from under the teacher. Row names are links that
open the student's card on the assessment page (`cardLink`), not a modal — consistent with "row names
navigate" elsewhere in triage.

**Tags** sit beside the student name, reusing the existing badge palette rather than inventing new
colours: `↩ arrived` is `.badge-resubmitted` (an outline ring in `--resubmit-ring`, no fill — a
resubmission that needs a look); `⟳ by DD/MM/YYYY` is `.badge-resubmit` (filled blue, `--badge-resubmit-bg`/`-text`
— an open ask, title-tooltipped with the ask's note); a grey `.badge-gray` "unsubmitted in Schoology" marks
a row auto-added from a teacher's own Unsubmit (not a manual ask); an amber `.badge-amber` "after
deadline" flags a resubmission that arrived past its `until` date. The same `↩`/`⟳` glyphs and badge
classes appear on the gradebook/student-page `SubmissionBadges` run, so the vocabulary reads the same
in both places.

**Card control (`ResubmitControl`, `.resubmit-control`).** Lives in the assessment card's header
(Flag for review sat beside it until 21 Oct 2026, #40). No open request: a plain pill button, "⟳ Ask to resubmit". An open request:
the same pill shape goes **active** (`.resubmit-pill--active`, thicker border, filled
`--badge-resubmit-bg`/`-text` — the same blue as the panel's `.badge-resubmit` tag) and reads
"⟳ Resubmit by DD/MM/YYYY". Clicking either opens an inline panel beside it (`.resubmit-control__panel`,
no modal — consistent with "Inline row editor" above): a `NumberStepper` for lessons (Settings-sourced
default) + an optional note, with Ask / Extend / Close request / Undo depending on state. An arrived
resubmission collapses the control to a single "Reviewed" button (grade stands). Prism-only — nothing
here writes to Schoology yet (Phase 2, on hold).

**Deep-link pulse.** A Dashboard/course-page resubmission row's name links to
`/course/:id/assessment/:aid?student=:studentId`; the assessment page scrolls that student's card into
view and gives it a 2s **outline** pulse (`.student-card--highlight`, `outline: 3px solid var(--accent)`
fading to transparent) — outline, not box-shadow, because the card's own inline `boxShadow` already
carries the resubmit-conflict ring (both a resubmit flag and a Prism "resubmitted" signal on the same
card) and an animated box-shadow would fight it. Runs once per distinct `?student=` value, even if the
page's data re-renders mid-grading-run. Reuse this outline-pulse-not-box-shadow pattern for any future
deep-link-to-card highlight.

### Status-line confirm (`StatusLineModal`, 2026-10-03 — spec Amendment B)

Every action that writes a **status line** to a student's Schoology comment (Ask, Extend, Grade stands,
late-work / make-up extensions, and Undo of those) goes through one confirm modal — the one place Prism
breaks the "inline, no modal" rule for triage, because the write is visible to the student and parents.
Its job is **significance**: header *Publish to {Name}'s Schoology comment*; a muted sub-line
*Visible to the student (and parents) as soon as you publish.*; a bold action-specific consequence
(e.g. *Ends the resubmission request: missed deadline, grade stands.*); the editable one-line status line
(a textarea, newlines folded to spaces); then *Their comment will read:* — the **full** resulting
comment in a `--bg-subtle` box with the new line highlighted as a `<mark>` in the resubmit blue
(`--badge-resubmit-bg`/`-text`, the same blue as `⟳` tags). A hidden comment (Display off) adds an
`.alert-warning` (publishing turns Display on). The primary button is verb-specific (*Publish & ask*,
*Publish new due date*, *Publish & close request*); Cancel is `.ghost`; Escape / backdrop press cancel
and never call a write API. Undo uses the same modal in remove mode: a *Remove Prism's line from their
comment* checkbox (default on) and the comment previewed without it.

The modal reads the comment fresh once, then composes the preview locally with the client mirror of the
server's `composeComment` (`client/src/lib/statusLines.js`), so editing the line is instant. A publish
that succeeded in Schoology but failed to record in Prism switches to an `.alert-error` headed
*Published to Schoology — not recorded in Prism* with only a Close button (retrying would publish again).
On phones it is a full-width bottom sheet with full-width buttons (PHONE LAYOUT block).
Focus moves into the dialog on open (the line's textarea; the dialog itself in remove mode — never the
primary button, so Enter can't publish by accident), Tab is trapped inside, and focus returns to the
opener on close; each opened action gets its own React `key` so the modal never carries stale line state.
Errors and warnings carry `role="alert"`; the preview is a labelled `region`. In remove mode the sub-line
reads *Changes their Schoology comment.*, and when Prism's stored line was published by a different
action the modal says it will stay (the server only removes a record's own line).

**Status lines are plain ASCII (2026-10-03, teacher decision).** The text Prism sends to Schoology never
carries a special character — `Resubmission requested - due Thu 08/10.`, `Extension - now due Fri 09/10
(3 lessons).`, `Resubmission received 14/10 - regraded.` — so no encoding round-trip can alter a stored
line (which must later match verbatim to be replaced). The `⟳` glyph stays on Prism's own pills, tags and
buttons only; anything that leaves Prism for a student's comment is printable ASCII. A line the teacher
edits in `StatusLineModal` is held to the same rule: typographic characters (curly quotes, dashes, `…`,
non-breaking spaces) are previewed and published as their plain forms, and any other non-ASCII character
shows an `.alert-warning` *Use plain characters in the status line* and disables the publish button (the
server's `checkLine` refuses it too).

Card control update: Close request and **Reviewed** are gone. An open request offers Extend / Grade
stands (only once the deadline has passed) / Undo; an arrived resubmission shows the muted text
*Awaiting your feedback — regrade or comment (visible)* instead of a button. In the triage panel the
arrived tag reads `↩ arrived · awaiting feedback`, red Waiting rows stack **Grade stands** above Extend,
and other Waiting rows "N left" above Extend.

### Unsubmit on Ask + Schoology connection card (2026-10-03 — Phase 2)

**Unsubmit checkbox.** An Ask on OneDrive (LTI) work Prism last saw submitted adds one checkbox to the
`StatusLineModal`, under the line: *Unsubmit their OneDrive work in Schoology so they can edit it*, default
**on** (the usual reason to ask is that they need to edit it). It reuses `.status-line-modal__check`; while
it is ticked the consequence line gains *Unsubmits their OneDrive work in Schoology so they can edit it.*
and the busy label reads *Publishing and unsubmitting…*, so the second write is never a surprise. It is
not shown for other work. When the saved Schoology session is expired (or was never set up) the box is
disabled and unticked, with a `.link` *Schoology connection expired — reconnect in Settings ›* to
`/settings#schoology` underneath — the teacher can still publish the ask on its own.

**Failure is a warning, not an error.** The ask is recorded either way. If the unsubmit fails, the modal
stays open with an `.alert-warning` (*Published and recorded — but their work is still submitted.* + the
reason) and an external link *unsubmit it in Schoology ›* (`target="_blank"`, `rel="noopener noreferrer"`)
to the assignment page whose grader has Schoology's own Unsubmit button; the only action is Close. The
triage row and the card show the same short note, `.unsubmit-failed` (warning colour, bold, link
underlined), until a sync sees the work in progress. Prism never re-submits, so Undo and Grade stands on
unsubmitted work append *Their work stays unsubmitted in Schoology.* to their consequence line.

**Schoology connection card.** Settings → *Schoology connection* (`id="schoology"`, the anchor the modal
links to) is one status line plus two controls: `SchoologyConnectionStatus` — a small dot
(`.schoology-connection__dot--success` / `--warning`, muted while unknown) and bold text *Connected ·
checked HH:MM* (en-GB 24-hour), *Expired* (the server's reason in the tooltip) or *Not set up* — with a
ghost *Check now* button (forces a re-check; hidden when there is no session to check), and a secondary
*Log in to Schoology* button with the muted note *Opens a Schoology login window on the server —
screen-share to it if you're away.* (UI copy says "the server", never the machine's name). The Sync
dialog's mastery step shows the same component beside its login option and offers the login when the
session has expired, so the status reads identically wherever it appears.

**Review fixes (2026-10-04).** The failure wording only says *still submitted* when Prism knows the unsubmit
wasn't accepted (never sent, or refused). When the request went out but Schoology never confirmed it, the
modal says *Schoology didn't confirm the unsubmit — their work may still be submitted. Unsubmit it in
Schoology ›* and the row/card note reads *Unsubmit not confirmed*. A live check that couldn't tell shows
*Couldn't check — try again* with a muted dot (never *Expired*) and does not disable the Ask checkbox. Undo
of an ask on unsubmitted work reads *Closes this request in Prism. Their work stays unsubmitted in
Schoology.* Both of the Sync dialog's login prompts carry the same *on the server — screen-share* note as
the Settings card.

**No em dashes in UI copy (2026-10-04).** Use a hyphen, comma or colon instead; a guard test enforces it (see AGENTS.md). Quoted copy elsewhere in this doc predates the rule and is historical, not a current example.

## Triage: "@" copies addresses, ✉ writes one email (October 2026, #137)

- **"@ ▾" in a panel header** (Make-up tests, Overdue work, Resubmissions) copies the addresses of students who still owe something: tiers Red / Red + amber / Everyone still owing, then By assessment. Format `a@x; b@x` for Outlook To or Bcc. Students who already acted (submitted late, resubmission arrived) are left out of the bulk copy. "@" was chosen over the word "Email" because it reads as *addresses* and keeps the header on one line on a phone.
- **✉ on a row** is a `mailto:` to that one student, subject `<title>: late work | make-up test | resubmission`. Course names are not in the subject: the stored Schoology names are long capitals and Prism has no short name.
- **No toast system.** Confirmation is an inline `role="status"` bubble under the button that clears after 5 seconds. If the clipboard is unavailable, a pre-selected read-only field holds the addresses to copy by hand.
- **Menu width is capped, not just right-aligned.** A long "By assessment" label truncates with an ellipsis (the count stays visible, the full "label (count)" is in the item's tooltip); the menu itself is capped at `min(18rem, viewport - 2rem)` so it can't run past either the 380px rail or a 390px phone screen.
- **Dashboard "At a glance" strip:** one muted status line (school day · last sync · Schoology connection, expired links to Settings), then up to four tiles (At referral limit, Make-ups overdue, Resubmissions overdue, Feedback overdue), each red number + red border. A tile scrolls to its panel and focuses its heading. 4 across on desktop, 2 x 2 on a phone. It replaces the header's school-day text and the old "Last sync:" line. See "Dashboard tiers" below for the October 2026 #137 follow-up that hid the zero tiles.

## Dashboard tiers: strip, cards, rail (October 2026, #137)

Each layer of the Dashboard answers one question, so the same red signal no longer shows three times over (it used to: strip tile, course-card chip, rail badge).

- **Strip = "is anything on fire?"** Only non-zero overdue tiles render; when all four counts are 0 the tile grid is replaced by one muted line, "Nothing overdue" (`.stats-strip__clear`), instead of a row of grey zeroes.
- **Course card = "which class needs me?"** One signal per card: a 3px worst-tone left edge (`card--tone-red` / `card--tone-amber`, an inset box-shadow so it doesn't shift content or fight `.card`'s own shadow) across make-ups, late work, resubmissions and feedback owed, plus — red items only — one muted line (`.course-card__triage`) like `2 at limit · 1 make-up · 5 to grade · day 16`. An amber-only card shows just the edge, no line. The make-ups/late/resubmissions/to-grade chips that used to sit on the card are gone; amber detail now lives only in the rail. The student-count badge is now plain muted text, not a `.badge` — it's a fact about the course, not a triage signal.
- **Rail = "what do I do about it?"** Unchanged: every row, every tone, every action (Refer, Extend, Grade stands, email).

Why: a red late-work row used to show once as a strip tile, once as a card chip, and once as a rail row — all for the same underlying fact. Tiering by "how urgent is this glance" removes the duplication without losing any information (amber and full detail are still one click away, in the rail).

## Single theme: Midnight and Ocean removed (2026-10-04, #133)

Prism now has exactly one palette, defined directly in `:root` in `client/src/app.css` — no `[data-theme="..."]` selector, no switcher, no `useTheme` hook. Midnight (dark mode) and Ocean (teal/blue) are gone: maintaining three palettes meant checking every visual decision against three sets of colours, and only the Prism purple/pink palette was in use. One palette to tune.

## One clock, one word: "day N" is always school days (October 2026)

Teachers were reading triage's "lessons" (extensions, resubmission deadlines) as a different unit from its "day N" (late work, feedback), because two words were in use for the same school-day count. The rule now:

- **No "day N" anywhere (amended 2026-10-07):** counts are distances in school days. Triage rings show school days late / waiting / since the test (the clock day minus one), subtitles say "school days late · refer at 8", "school days waiting · overdue at 10", badges "submitted 8 school days late", Settings "Refer late work at 8 school days late". The timetable's cycle days are numbered 1-8, so any "day 5" read as cycle day 5. "N left" stays short (the subtitle carries the unit; "N school days left" overflowed the action column).
- **Deadlines say "school days"** wherever a number is picked or shown (Extend, Ask to resubmit, Settings, the student-facing extension line). The word "lessons" is never used as a unit.
- **"Lesson" means a class meeting, and only appears as a hint:** under every deadline stepper, `LessonHint` shows where the count lands in the class's own timetable, "→ Thu 15/10 · 3 lessons from today", with **Next lesson / 2 lessons** picks that set the school-day number. The date is the anchor; the count is secondary.
- **Explain once, on hover:** one `HelpDot` per surface ("Day 1 is the due date (or the extended date). Days are school days. Day 8 is the last day to submit; after it, work is referred."), not more text. On a table, one dot in the header, not one per row.

## Submission timeline row (October 2026)

The full submission picture in one compact, wrapping row of short facts (`SubmissionTimeline`, `.submission-timeline`): due (+ extension), submitted when and how late ("3 school days late"; "42 min late" on the due date; "late, before the next school day" over a weekend), or "Not submitted · 5 school days overdue" if missing, then resubmission asked / arrived, referral. Parts are separated by a CSS middle dot; late text is `var(--warning)`, past the limit `var(--danger)`; nothing renders for facts that don't apply. Same words everywhere because one formatter (`client/src/lib/submissionTimeline.js`) builds them: the /assessment/ card (under the header, aligned past the avatar), the gradebook rubric modal, the student page (per assignment, replacing the raw "Due:" text). In the gradebook grid it is the cell's hover text, and graded late work keeps a small **L** (submission badges otherwise vanish once a cell is scored).

`HelpDot` (`client/src/components/HelpDot.jsx`) is now the component form of `.help-dot` + `.help-pop`. The popover behind it is also exported as the `useHelpPop` hook (`handlers` for the trigger, `popover(content)` beside it), used by anything else that wants the same instant popover without a "?" glyph (the student page's gender tag and the Roster tab's Gender pills, 25 Oct 2026).

**Lateness is a distance, never "day N" (2026-10-07).** On the timeline, "day 5" was read as timetable cycle day 5 (the school's 8-day cycle numbers its days 1-8). Lateness now reads "4 school days late" / "5 school days overdue" (the clock day minus one), and the "?" says "Counted in school days after the due date (or the extended date). Work 8 or more school days late is referred." On a phone each timeline fact sits on its own row with no dots; elsewhere the dot trails the part before it, so a wrapped line never starts with one.

## Waive, and deadlines that count from today (October 2026)

- **Waive, not Ignore or Excuse.** A late submission past the referral limit can be referred or *waived*. "Ignore" reads as neglect in a record the academic office may see; "Excuse" clashes with Schoology's *Exempt* flag (not required to do the task). The button says **Waive**, the confirm button **Waive referral**, the history **Referral waived · 8 school days late** (grey, not red), with the teacher's optional reason. Extend is not offered on work that is already in.
- **A deadline you set is always in the future.** Extending counts from the later of the start date and today, so the hint never says "already passed" and "Next lesson" is a small number. The extension tag and history show only the resulting date ("ext → 19/10/2026", "Extended to 19/10/2026"): a count from a moving start would mislead. *Superseded for assignment extensions on 27 Oct 2026 (next bullet); a resubmission ask's extension still works this way.*
- **Extensions count from the due date, with "From today" as the other choice (27 Oct 2026).** A teacher giving overdue work "3 more days" means 3 days on top of the original deadline (Graham: a student 5 school days overdue should be left 2 school days overdue). Once the due date has passed, every Extend editor (the card, the triage rail's late work and make-ups, the Roster tab's Needs attention) shows two `.filter-btn` pills after "school days", in a `role="group"` named "Count the school days from": **From due date Mon 19/10** (selected by default) and **From today**. Before the due date they give the same deadline, so the pills are hidden. A deadline counted from the due date can already be past, and the lesson hint states how late it leaves the work: "→ Thu 22/10 · 2 school days overdue", or "due today". The confirm names the start: "counted from the due date (Mon 19/10)" or "counted from today". Switching the pill re-fills the stepper from the current extension (its school days after the due date, or the school days left from today). Graham chose the due date as the default for tests too: a missed test is followed in make-up triage, and he rarely extends one.
- **Extend lives on the card too,** beside *Ask to resubmit*, styled the same way (pill → inline panel → status-line confirm): "Extend" before, "Extended to DD/MM/YYYY" after.

## Card actions: pills in the header, editors in a row below it (October 2026)

The /assessment/ card header holds one line of action pills (Refer, Waive / Extend, Ask to resubmit; Flag for review was removed 21 Oct 2026, #40). An action that needs input opens its editor (`ActionPanel`) as a full-width row directly under the header (`.card-action-panel`, `var(--bg-subtle)`), never inline among the pills, which made the header wrap and squeezed the stepper. The editor has two rows: a bold title + the deadline (stepper, "school days", lesson hint, Next lesson picks), then the note field, the primary action and Cancel. The card shows the same triage actions as the dashboard row, from the same rules: missing work at the limit gets Refer + Extend; work handed in late at the limit gets Refer + Waive and no Extend (the work is in); a decision shows as a "Referred" / "Referral waived" badge with Undo. The pill whose editor is open is drawn as selected (`aria-expanded="true"`: pale accent fill, 2.5px accent outline), deliberately not a solid fill, which read as another primary button beside Refer. **Refer is red everywhere** (card: a red-outlined pill; rail: `button.primary.danger`), matching the red ring, the "to refer" badge and "Referred": the accent purple is reserved for the selected / open action, so a referral can never be mistaken for it.

## Unpublished assessments behind a filter (October 2026)

- **Assessments tab:** the Summative / Formative toggles gain a third pill, **Unpublished** (grey, `badge-gray` colours), off by default. It appears only when the course has unpublished assignments. Turned on, unpublished rows show a muted italic title and a small grey "Unpublished" badge. The type pills still apply to them (OR within types, AND with Unpublished).
- **Gradebook tab:** the same three toggles in a **compact** size (`TypeFilterBar compact`, `.type-filter-bar--compact`) sit right-aligned in the course tab row beside "Triage ▸", so they take no vertical room from the diagonal headers. An unpublished column's diagonal title is muted italic; its hover popover adds "Unpublished on Schoology".
- **One rule, two tabs:** `client/src/lib/assessmentTypeFilter.js` holds the filter and counts. Each tab keeps its own selection in memory (resets each visit). The `/gradebook` endpoint returns unpublished assignments with `published: 0`; the other course listings still exclude them.

## Test attempt link (October 2026, linked quizzes)

- **"Attempt" is the #120 "Open" pattern again.** One small outbound link labelled **Attempt**, beside the submission-status pill on the `/assessment/` cards, in the gradebook rubric modal's badge row and in the status cell of the student page. The full sentence is the accessible name ("Attempt: open Ada's test attempt in Schoology"); the completion time (day-first) is in the tooltip. Nothing renders when the student has no attempt. The shared component is `components/quiz/AttemptLink.jsx`.

## Quiz setup modal (October 2026, linked quizzes)

- **Combine is gated on a parity check, and the gate is visible.** The modal ticks the current test and its suggested copies. Combine stays disabled until **Check questions** passes for exactly that ticked set; a single ticked test needs no check. A mismatch lists each test's missing and extra questions inside `.alert.alert-warning`, and a match shows "Same questions" in `.alert.alert-success`. Any change to the ticks drops the old result, so the teacher cannot combine on a stale check.
- **Remove is two steps.** "Remove quiz group" reveals an inline sentence that says loaded results are removed and Schoology is not changed, with a second **Remove** button. Nothing is deleted on the first click.
- **The result-task select lists each summative once.** The linked result is listed first; the other summatives follow, with "Not linked" as the empty choice. The shared component is `components/quiz/QuizSetupModal.jsx`, built on the existing `.modal-overlay` / `.modal-content` pair.

## Questions tab (October 2026, linked quizzes)

- **Facility is a bar, then the number, then the band.** Each MCQ row shows a thin `var(--accent)` fill on `var(--bg-subtle)`, the percentage, and the band as a plain `.badge` (Strong, Mixed, Divided). FRQ rows carry no facility bar: they show their own level counts ("Exhibiting Depth 2, Developing 4") in its place, in full level names, because initials collide (Exhibiting and Emerging).
- **The key is marked, never coloured.** Option counts read "B 10 ✓" in bold. Colour is reserved for flags, so a correct answer is not confused with a warning.
- **Flags map to the existing badge tones.** Critical flags use `.badge-red`, warnings `.badge-amber`, and notes a neutral `.badge`. Flags are counts and distractor observations only; there are no discrimination indices.
- **Rows expand, not navigate.** The whole first line opens the row (`.question-row-head`); its own buttons and the tag field keep their clicks. The question number stays the `aria-expanded` button for keyboard users. The collapsed stem is one line cut by a CSS ellipsis (`.question-stem-line`), with the full stem in the hover title. The expanded options drop the "a." or "b)" that Schoology writes at the start of an option, because the row already shows the letter.
- **Takers are counts, not titles.** "Takers 6 of 6 (5 + 1 across 2 tests)"; the test titles and their counts are in the hover title.
- **"Lowest first" is a `.filter-btn` toggle.** It sorts by facility, with FRQ rows last. It changes order only, never hides a question.
- **Tags are edited in place.** "Edit tags" opens a comma-separated field inside the row; saving reloads the stats so the tag rollup stays in step. The shared component is `components/quiz/QuestionsTab.jsx`.

## Quiz controls on the assessment page (October 2026, linked quizzes)

- **Quiz controls sit in the existing header row.** **Quiz setup…**, the chip, **Load results** and a "loaded {date} / not loaded" line follow **Manage rubrics…** as `.secondary` buttons and small muted text. They show only when the `quizzes` flag is on and the assessment is a test or already in a group. The load result line ("18 attempts loaded, 1 failed") replaces the loaded-at text until the page is reopened. **Load results** is a run in the sync queue (#131): when it outlasts the server's 50 s wait the button stays busy and follows the run until it finishes, then shows the same line.
- **Grading and Questions are `.tab-btn` tabs under the filter bar,** present whenever a group exists. The choice lives in `?tab=` (sticky), and Questions replaces the student cards rather than sitting beside them.
- **One canonical page per group.** Any other member redirects (replace) to the canonical assessment and keeps the query string.
- **The course Assessments list folds member tests** under the canonical row, which carries the `QuizChip`. Gradebook columns are not folded.
- **The chip shows a count, never the titles.** `QuizChip` reads "2 linked tests ▾" (or "combined" without a result task) as a small accent-outlined button (`.quiz-chip`). A click lists the titles in a `.help-pop` box, aligned to the chip's left edge rather than centred, because the chip often sits at the content's left edge beside the sidebar; the hover title holds the result task and the titles. A test and its extra-time copy have long, nearly identical titles, and printing them pushed the assessment title into a narrow column.

## Quiz load warnings (October 2026, linked quizzes)

- **One compact `.alert.alert-warning` under the header, above the Grading / Questions tabs,** so both tabs see what the last load could not do cleanly. It lists, in order: copies that differ ("The combined tests differ:" plus each line, e.g. "Question 4: a different key"), students who could not be loaded (count, then each reason, by name when Prism knows the student), students Prism does not know ("Sync the course, then load again."), and students with more than one attempt ("Prism used the latest."). Nothing renders when all four are empty. The shared component is `components/quiz/QuizLoadWarnings.jsx`.
- **Folded tests keep their make-up chips.** On the course Assessments list a canonical row also shows each member test's make-up chip, using the same toggle as a test's own chip, so folding never hides make-up tracking. With two or more tests the chips read "Make-ups (Test 1): tracked", numbered in group order, with the full test title in the hover title. The chips sit in one wrapping group, so they move to a second line together.
- **A folded row wraps before it squeezes.** Assessment rows wrap (`flexWrap`), and the title keeps at least 20rem, so chips move below the title instead of narrowing it.
- **Published tests keep their folded row visible.** A result task is often unpublished until grades are released. Its folded row stays in the default list while any member test is published, still with the grey "Unpublished" badge for the result task itself.

## Questions tab charts (October 2026, linked quizzes phase 1b)

- **MCQ scores are a dot plot first.** `ScoreDots` draws one dot per student on a fixed 0 to 100% axis, stacking dots that fall in the same column, with the median as a dashed line. Graham chose it over a plain box plot because the dots never overlap and a class of 6 to 22 is easy to count. A **Dots / Box** toggle (two `.filter-btn`s) switches to box and whiskers (Tukey hinges, minimum to maximum) with the dots over the box, which suits looking at individual students. The choice is stored per browser (`localStorage`, `prism.quiz.scoreChart`).
- **A dot names its student on hover.** The name and "17/20 (85%)" show in a `.help-pop` above the dot; the dot's `aria-label` holds the same text, and the chart's own label states the count, median and range.
- **Levels are a stacked bar in the rubric-grid colours.** `LevelBar` uses `LEVEL_COLORS` header fills, best level on the left, with "ED 2" inside a segment wide enough for it (12% of the bar) and a legend of full names under the summary bar. A level name outside Prism's five, and "Not marked", is neutral `var(--bg-subtle)`. The FRQ question row uses the thin `mini` bar beside "ED 2, D 4".
- **Tags show their full text on hover.** A tag with stored text (`quiz_tag_texts`, imported by an agent from the CED) has a dotted underline and the text as its hover title, on the question row and in the By tag table. Teachers do not hold code wordings in their heads.
- **Percent bars are one primitive.** `.pct-bar` is the thin accent bar on `var(--bg-subtle)` used for each question's facility and each tag's percent correct.
- **Built to be reused.** `ScoreDots` and `LevelBar` live in `components/quiz/` so the score-distribution drawer (#78) can use the same charts.

## Free response tab (October 2026, linked quizzes phase 2)

*(Folded into the Attempts tab by #200, 26 Oct 2026: see "Attempts tab (#200)" below. The views, filters and Publish all live on there.)*

- **Two views, one picker.** **By question** (the default) shows every student's answer to one FRQ, chosen with one picker for the whole list, under the question's stem. **By student** stacks each student's FRQs. The view and filter buttons are `.filter-btn`s in one bar, which is not sticky because the assessment page header already is.
- **Filters name the work left.** All, To review, Accepted, Waiting to post, Posted, Failed, Changed in Schoology. While `quiz_writeback` is off the bar also shows "n waiting for the agent".
- **Card order:** the name with the **Attempt** link and state chips; the answer on `var(--bg-subtle)`; the Schoology rubric grid; the comment; then **Accept** (`.primary`), **Save edit** (`.secondary`), **Keep mine** and **Copy comment** (`.ghost`).
- **Three marks in one grid.** `FrqRubricGrid` shows the stored Schoology rubric with a level button per cell: the card's current cell is filled in its level colour (`LEVEL_COLORS`), the AI's cell has the fuchsia sparkle (and the AI wash when it is not the current cell), and Schoology's current cell has a small outlined "S". Clicking a cell changes the card's level.
- **The comment starts from the closest mark:** the teacher's own, else the AI suggestion, else Schoology's comment, so an answer already marked in Schoology opens as it is there.
- **Chips:** Suggested (`badge-pink`, the AI colour), Accepted or Edited (`badge-blue`), In Schoology or Not marked (`badge-gray`), Waiting to post (`badge-amber`), Posted (`badge-green`), Post failed (`badge-red`, the error in the hover title), Changed in Schoology (`badge-amber`), Revised suggestion (`badge-pink`).
- **Student answers are sanitized.** Answers render only through `sanitizeAnswerHtml` (DOMPurify, with every attribute removed): formatting and code survive, and scripts, images and links are removed. The question stem goes through `sanitizeStemHtml`, which also keeps an image from an http(s) address with its alt text (phase 3), so a stem diagram shows.

## Overall result on the Result task (October 2026, linked quizzes phase 3)

- **The quiz line sits beside the Attempt link.** On a linked Result task each Grading card shows "MCQ 17/20 (85%), FRQ Q21: Exhibiting" in `var(--text-muted)` at 0.78rem (`.quiz-result-line`, `QuizResultLine.jsx`). An FRQ that is not confirmed shows its reason ("Q21: to review", "Q21: not marked"). The numbers are live from Prism's copy, not from the suggestion.
- **The student name stays on one line.** The card's name link is `white-space: nowrap`, so a long quiz line wraps its own badge and button instead of breaking the name.
- **A stale comment is flagged, not rewritten.** When the suggested comment no longer matches the numbers or the template, the line adds an amber "Numbers changed" badge and a small `.ghost.accent` **Update numbers** button. The update keeps the agent's impression and levels, so a comment the teacher already used comes back tagged Revised, as any revised suggestion does.
- **The comment template lives in Quiz setup.** Shown only when the quiz is linked to its Result task: a five-row textarea under "Overall comment", with the placeholders named in one muted line above it. **Save template** (`.secondary`) is disabled until the text changes; **Reset to default** (`.ghost`) appears only for a saved template. A refused template shows its reason in the modal's existing warning alert. Saving keeps the modal open.

## Publishing FRQ marks to Schoology (October 2026, linked quizzes phase 4)

- **One button, the grading surfaces' verb.** While `quiz_writeback` is on, the Free response bar shows **Publish all to Schoology (n)** (`.primary`) in place of "n waiting for the agent", matching the Grading tab's **Publish all to Schoology**. It publishes every accepted mark on every FRQ of the quiz. Graham dropped the earlier "one student first" step (13 Oct 2026): every write is read back, and feedback is usually hidden from students until he releases it.
- **A line per student** under the button: "Published: Name, Q21 Exhibiting" in `var(--success)`, "Failed: Name, Q21: reason" or "Skipped: Name, Q22: reason" in `var(--danger)`. A failed mark stays waiting, and the button returns with the new count. A refused publish (busy, expired session) shows in the bar's `.alert.alert-warning`. `PostMarksBar.jsx`.
- **One muted warning:** "Close any grade-by-question page for this quiz in Schoology first: saving it later would undo these marks." Prism writes through that page's form, so a stale tab saved later sends its old values back.
- **The cards reload after each publish,** so their chips show Posted or Failed from the read-back.

## Linked quizzes: what phase 1 keeps constant (October 2026)

- **Statistics stay counts.** Facility bars, bands (Strong at 90% and above, Mixed at 70% and above, otherwise Divided), option counts with the key marked, and flags. No discrimination statistics, on purpose: a class-sized cohort cannot support them.
- **The gradebook keeps a column per test,** because each member test still carries its own score. Only the course Assessments list folds them into one row with the chip.
- **Read-only against Schoology.** Combining, linking and loading change nothing in Schoology; the setup modal says so before **Remove**.

## Feedback rows on an unaligned task (2026-10-13)

- **Layout:** the rubric grid first, labeled "Feedback rows: kept in Prism, not sent to Schoology"; the overall scale picker under it, labeled "Overall: {scale}, sent to Schoology". The grid is the aligned-task grid, unchanged.
- **The rubric average:** staged on the overall picker by itself only while nothing is published, with the hint "Average of the rubric rows: {level}". A different pick turns the hint into the button "Use the rubric average ({level})". No override badge: one element carries the state.
- **Insufficient Evidence:** stops the average; the hint asks the teacher to choose the overall level.
- **Manage rubrics:** on an unaligned task the **Map criteria** tab is disabled, and an `.alert.alert-info` under the tab bar says "On an unaligned task, every criterion is a feedback row".
- **Same grid as an aligned row (Graham, 13 Oct 2026):** the first column reads "Criteria", and the second line of a row is its standard (the rubric's Measurement Topic text), where an aligned row shows its topic title.
- **Overall picker follows the view toggle:** Descriptors shows each level's description; Compact shows the level names only, so the rows carry the detail.
- **Save button:** a save that changes only feedback rows reads "Save in Prism" (nothing goes to Schoology); any change to the overall level, comment or visibility reads "Publish to Schoology".
- **Category colours (Graham, 13 Oct 2026):** every criterion cell, on aligned rubrics and feedback rows alike, is filled by its reporting category in the house rubric style: Producing purple `#B4A7D6`, Creating, Responding, Connecting blue `#9FC5E8`, Computational Thinking orange `#F9CB9C`, Content Knowledge pink `#D5A6BD`. The `config.yaml` keywords are stems ("produc", "creat") so the aligned titles ("HS Art: Producing") and the rubric files ("PRODUCE") both match.

## Assessment page: Needs action and Watch (October 2026)

The /assessment/ filter used to be one row of descriptive pills: OR within a group, AND across groups. Picking every pill that meant "unfinished" (Ungraded + Partially graded + Not visible + Ask to resubmit) showed nobody, because no student had all of them. The page now answers "who needs me?" first.

- **Two reason rows, "any of":** **Needs action** (your move now: To grade, Partly graded, Draft not published, Comment hidden (on an unpublished task: Feedback hidden (task not published), #184), Resubmitted, Referral to decide, Resubmission overdue, Make-up test) and **Watch** (may need a word with the student: Not started, due soon; In progress, past due; Late, before the limit; Resubmission pending). Every selected reason in both rows combines as "any of". A pill shows only while some student has that reason (or it is selected); an empty row reads "Nothing needs action" / "Nothing to watch". The page opens with nothing selected: all students.
- **Refine (collapsed):** the old descriptive pills, still OR within a group and AND across groups, narrowing whatever the reasons selected. "Not visible" now counts only feedback that exists. Refine opens by itself while one of its pills is active.
- **Reason chips on each card:** a row under the header, aligned past the avatar like the timeline, with the same names as the pills plus the detail ("Referral to decide, 11 school days late", "Resubmission due 20/10"). Late clocks take triage's green / amber / red.
- **The list holds still while you work:** who matches is worked out when the filter changes, not on every save, so a card stays in view after its reason is resolved. "N shown students no longer match the filter. Update the list" refreshes it. Filtered-out cards stay mounted and are only hidden, so an unsaved draft survives a filter change. The class-wide bar (Publish all, Discard all, Show all, Mark all, Accept all) acts on the shown cards.
- **One source per reason:** the calendar reasons come from triage's own rows (`server/services/cardAttention.js`), so a card never disagrees with the dashboard; the grading reasons are worked out on the page (`client/src/lib/assessmentFilters.js`) and follow each save at once.

## Triage: Unfinished grading and filtered links (October 2026)

- **Unfinished grading panel** (named "Loose ends" for its first two days; renamed 17/10/2026 to say what it holds): in the triage rail (Dashboard and course page), one row per task with unfinished work that runs on no clock: drafts not published (a live Prism draft; one Schoology changed under is left out, the same check the card makes), feedback hidden (a teacher comment the student cannot see; since 24/10/2026 also every student with a score or comment on an unpublished task, shown as "3 with feedback hidden (task not published)", #184; on a published task "1 with comment hidden" since 25/10/2026, because Display hides only the comment), unread student comments. No ring and no action column, because nothing here is late: title, then "2 drafts not published, 1 with comment hidden, oldest draft 09/10/2026", then the course line. Tasks with a draft come first, oldest first. Hidden when empty, like Resubmissions. No Stats strip tile: the tiles are for overdue work.
- **Links open the page already filtered (`?filter=`):** an Unfinished grading title selects that row's reasons; a Feedback owed title selects the whole Needs action row (`?filter=action`; a group name stands for its row); a Resubmissions name focuses the student and selects Resubmitted (arrived) or Resubmission pending + overdue (waiting). Overdue work and Make-up names still only focus the student.
- **Feedback owed is unchanged:** hidden feedback is its own count, not a reason to keep the feedback clock running, because feedback is sometimes held on purpose (moderation).
- **Draft validity on the server:** `server/lib/assessmentDraft.js` mirrors the client's `draftBaseline` (parity test in `client/src/lib/assessmentDraft.test.js`), and `unfinishedGrading.test.js` checks the server baseline against the one the card computes from the real `/api/mastery/.../assignment/...` payload.

**Amended 17/10/2026:**
- **Panel order is by urgency:** Unfinished grading on top whenever it has rows (quick fixes, a standing reminder), then the clocked panels by their most urgent row (red, then amber, then the rest), keeping make-up tests, late work, resubmissions, feedback owed within a level (`orderPanels` in `TriageSection.jsx`). An overdue Feedback owed no longer needs a scroll.
- **Resubmissions show whatever the type:** an arrival is the student answering the teacher's feedback, so a response is owed on formative work too. The Feedback owed Formative tick now affects Feedback owed only.
- **Assessment page rows toggle as a group:** the "Needs action:" / "Watch:" label is a button (text-styled, accent while the whole row is on) that selects every pill in its row, or clears the row. A reason pill shows only while some student has it, even when a link selected it.

## Submission comments (October 2026)

A student's Schoology submission comment thread, read in Prism (spec `docs/superpowers/specs/2026-10-17-submission-comments-design.md`; mock approved by Graham 17/10/2026). Students often type their answers in the comment box, so their own text must stand out from Schoology's automatic lines.

- **Card chip:** a comment bubble with the count in the card header, after the quiz line (`.comment-chip`). It shows even before a read (outlined, no number) so any thread can be opened. An amber **Wrote in comments** badge (`.comment-wrote`) follows when a student comment holds their own text. On a phone the badge is hidden and the chip itself turns amber (`.comment-chip--wrote`), because the header has no room.
- **Gradebook cell:** a 16px bubble (`.comment-dot`) after the badges, only when the cache holds comments; amber when the student wrote text. The gradebook reads the cache only.
- **Popover (`.comment-pop`):** fixed and portalled to the body, so no card or table clips it; Escape or a click outside closes it. Oldest first, author and `formatDateTime` date per comment. "Revision N submitted" lines are faint italic (`.comment-auto`); student text is an amber block labelled **Student wrote** (`.comment-student-text`); teacher text is plain. The foot states when the thread was read, with Refresh.
- **Files on comments:** each file is a link chip with its size, served through Prism (`.comment-file`); a student's file is amber (`.comment-file--student`). A student file without typed text badges the card **File in comments**, and turns the chip and cell bubble amber like typed text.
- **Attach file:** a secondary button beside Post comment; the chosen file shows as a chip with Remove (`.comment-file`), and the confirmation names it.
- **Writes confirm inline:** Post comment and Delete each open a red confirmation (`.comment-confirm`) naming the student, because a post reaches the student at once. Delete appears only on your own comments.

## Native dropbox files (October 2026, #107)

A student's own Schoology uploads, every revision, for tasks that take files in Schoology rather than OneDrive.

- **Chip, not a list:** a paperclip chip (`.comment-chip .files-chip`) beside the status pill (where an OneDrive task shows its "Open" link), shown only when the sync saw a native upload (`hasNativeSubmission`: not OneDrive, not a test, `submission_type` "drop"). It reuses the comment chip so the two read as one family. Before a read it says **Files** (outlined); after, **3 files** (filled) or **No files** (outlined). The page reads cached counts only, so no chip costs a Schoology call until it is opened.
- **Popover:** the comment popover's frame (`.comment-pop`), titled **Submitted files**. Revisions newest first, each headed **Revision N** with its `formatDateTime` time and small tags (`.files-tag`): **Latest** (only when there are two or more), **Late** (amber, `.files-tag--late`), **Draft**. Each file is a chip with its size (`.comment-file`) and a quiet **Download** link beside it (`.files-download`). A file Prism can show is a button chip (`.files-view`) that opens the viewer; any other file is a plain chip.
- **Viewer (`FileViewer`, `.file-viewer`):** a lightbox above the popover (and above the gradebook pop-up): a dark scrim, a white panel whose head holds the file name, "Student, revision N", a short note and **Download** + **Close**; the body is the image, video (native controls) or PDF (an iframe in the browser's own viewer), sized to the window. Escape or a click on the scrim closes the viewer only, back to the list. On a phone it fills the screen.
- **Which copy:** a video plays its original first (H.264 `.mov` plays in Chrome too), falls back to Schoology's converted `.mp4` if the browser cannot play it, and the note offers the other copy ("Play Schoology's converted copy" / "Play the original"), because the copy is much smaller and lower in resolution. A `.docx`, `.html` or similar shows Schoology's PDF copy, noted as such; an image the browser cannot show (HEIC outside Safari) falls back to its PDF copy or says to download it. The foot of the popover states when the list was read, with Refresh.
- **Gradebook pop-up:** the same chip in the badges row; it reads the student's files when the pop-up opens, because opening the pop-up is opening the student's work.
- **Files open safely:** images, videos, audio and PDFs are served inline; anything else (a student's `.html` included) only downloads, sandboxed, so it never runs inside Prism.
- **Student page (18/10/2026, #162):** the same chip in each assignment's badges row, between the OneDrive **Open** link and **Attempt** (the gradebook pop-up's order), on a task the sync saw the student upload to. Like the comments chip, it loads after the page renders and only for this student: `GET /api/submission-files/student/:id` returns their cached counts and queues a background read of their uploads in current courses (one GET at a time, skipping pairs read in the last 10 minutes), with one re-read later, so the chip turns from **Files** into **3 files** while the page is open. Archived courses are not read in the background (years of tasks would cost a call each per visit): their chip says **Files** until it is opened. With the feature off, no chip.
- **Comment files in the viewer (18/10/2026, #162):** a file on a submission comment that Prism can show (image, video, PDF) is a button chip (`.comment-file.files-view`, amber `--student` when the student attached it) that opens the same `FileViewer` over the thread, captioned with the comment's author and time; Escape or the scrim closes the viewer only, back to the thread. Any other file is a link that downloads. They no longer open a new tab. Comment files have no converted copy (the PNGs checked list none), so the viewer shows the original only.

## Assessment page filter controls (October 2026)

Chosen 17/10/2026 from three mockups (tri-state pill, tray, segmented): option A, with Refine moved to the end of the Watch row.

- **Group pill:** each reason row opens with an outlined pill holding a select-all checkbox: empty box = none on, dash = some on, tick on a filled pill = all on. Its count is how many students have any reason in that row. Needs action uses the accent; Watch the muted ink. A thin divider separates it from the row's pills. It shows only when the row has a pill.
- **Refine:** an outline button with a filter icon at the end of the Watch row, a count badge for its active pills and a ▾/▴ chevron. Its pills open in a white box under the rows, groups separated by space (dividers left a stray line when the pills wrapped). "Ask to resubmit" is gone: Resubmission pending + overdue cover it.
- **Status line:** under the rows, "Showing 10 of 20 students" (or "Showing all 20 students"), the "N no longer match. Update the list" note when the frozen list has resolved cards, and a red-outlined **Clear all** with an × icon while any filter is on.
- **Watch labels:** "Late" (was "Late, before the limit"); new **Referred, not submitted** for a referred student whose work has still not come in (chip "Referred 12/10, not submitted"). Past the limit and not yet referred stays **Referral to decide** in Needs action.

## One grade card (October 2026, #176)

`StudentRubricCard` (`client/src/components/gradeCard/StudentRubricCard.jsx`) is the only component that draws a student's grade and comment on one task. The assessment page, the student page and the gradebook pop-up all render it, so a later change to the card reaches every view. It replaced `AssignmentFeedback` (the shared read-only view of #135, deleted), which had drifted from the card. Graham, 23 Oct 2026: "I don't want to create more bespoke UI components that differ from those with a similar function." Design: `docs/superpowers/specs/2026-10-23-edit-grades-outside-assessment-design.md`.

- **Two modes, one component.** `mode="edit"` is the assessment page's card, unchanged. `mode="view"` is the read-only card: it draws what is published, with no editor, draft saver, autosave or listeners, and reports nothing to a page. The card remounts when its mode changes (`key={mode}`), so edit mode starts from the props it is given at that moment.
- **Edit and Done, in place.** A view card with `onEdit` shows **Edit** (`.secondary.btn-sm`) at the end of its header badges; choosing it switches that task's card to edit mode inside the page or pop-up. In edit mode `onDone` adds **Done** (`.ghost`, at the right of the action row): the queued draft save lands first, then the card returns to the view, refreshed from the server. Drafts save themselves, so there is no Cancel. Several tasks may be open at once; each card is independent. The shared logic is `useCardEditing` (`client/src/hooks/useCardEditing.js`), used by both pages. On Edit it rereads that one card and edit mode starts from that read, even while a reload from an earlier Done is still in flight (`useGradeCards` puts a card read in unless a full load issued after it has already landed), so a second Edit never starts from a stale draft. Leaving edit mode (Done, collapsing the course, closing the pop-up) unmounts the editor, which sends its queued draft save (keepalive) or queued delete. On the student page, Done reloads the student and that task's course (its summary and cards), not every course. The sections are keyed by student and course, so moving to another student's page never carries a task in edit mode across.
- **Edit only where Prism can write.** The card has no Edit in an archived or excluded course or a linked-section set (#178): `course.writable` from the grade-cards route, the same rule `courseSections.assertSectionWritable` applies to every Schoology write. The read-only view stays as it is there. Every write the card makes uses the assessment page's existing publish, flag, refer, extend and resubmit code; the cards add no write path.
- **Meeting (`meeting` prop).** For a student conference the card hides the student's portrait and every AI suggestion: suggested levels in the grid (the cell state and its sparkle), the narrative suggestion box with Use / Ignore / Show again, Reviewer notes and any other `AiSparkle`. The student page and the pop-up always pass it; the assessment page does not.
- **Add update.** An **Add update** button (`.ghost.btn-sm`) sits beside the comment on every surface, shown only when the comment box holds text. It puts `Update (DD/MM/YYYY): ` (today, `formatDate`) on its own line above the comment, then a blank line, then the comment unchanged, with the cursor after the colon, so an appeal's change stays on record above the original text. A status line (Ask to resubmit, Extend, a flag's reason, resubmission received) must stay on line 1, because `composeComment`, `topLineIs` and `removeStatusLine` match it only at the start: when the comment starts with one, the update goes directly below it. A second press on the same day moves the cursor to the existing update line instead of adding another. Code: `client/src/lib/commentUpdate.js` (`addUpdateLine`). Hidden in view mode.
- **The draft mark.** In edit mode the comment shows "Draft - not published" while it differs from the published text. A view card shows the same mark when its task holds a current draft (`hasDraft`), so an unfinished change is visible in the room as well as in Triage's Unfinished grading panel. Drafts are the card's existing store (`assessment_drafts`), so work started on one surface continues on another.
- **Points-only tasks** (a score in points, no topics, no scale) put **Score:** in the rubric's place and show the points only (no scale level). A points task on a named Schoology scale that `scoreScale` does not cover is labeled through the `scales` prop (the student page passes `student.grading_scales`).
- **The points box (#181, 23 Oct 2026).** In edit mode, a points-only task's **Score:** line is a short text box (`.grade-card__points-input`, 5rem, `inputMode="decimal"`) holding the published score, with "/ 50" (the maximum) beside it. Typed points are staged like a level (they count as a pending change, autosave as the draft under `__points__`, and turn Display on for an empty record) and go to Schoology with the comment on Publish or Publish all. Decisions the agent made (Graham left them open): a score over the maximum is allowed (Schoology takes extra credit) with the muted note "Over the maximum of 50."; text that is not a number of 0 or more shows "Enter a score of 0 or more." in red and disables Publish; an emptied box over a score is that error too, because Prism never removes a score (as with a scale level). No box on a test or quiz (Schoology scores them), on a named Schoology scale, or under Exempt or Missing, where the read-only score and the flag symbol stay. A marker (Late, Incomplete, Absent) keeps the box, and the points clear the flag. The rule lives in `client/src/lib/pointsTask.js` (`canEditPoints`), mirrored by `server/lib/pointsTask.js`.
- **`showDue`.** The student page has no header that shows a task's due date, so it passes `showDue` and the submission timeline starts with the due date. The pop-up and the assessment page do not.
- **Feedback rows.** An unaligned score-scale task with a rubric attached shows the rubric's rows (first column "Criteria") with the published row levels as the awarded cells. The overall level shows as the scale picker (the card's own control), not the old read-only "Overall: 75 / 100" line.
- **One clock "?" per card.** The late clock's help sits once on the card, in the submission timeline, instead of in the table header that `AssignmentFeedback` drew.
- **Flags.** The two final flags, Exempt and Missing, lock the rubric: the grid is drawn at 45% and cannot be clicked, with the badge "Exempt, rubric locked" (or "Missing, rubric locked") in the header, in every mode and on every surface. Missing shows IE on every topic or feedback row when Schoology holds no levels (`client/src/lib/missingView.js`, see "Missing shows IE" below). A marker (Late, Incomplete, Absent) keeps the rubric open, with its symbol and "Grading this work clears Late." above it, because the teacher grades straight through it. The Flags pill and its panel sit in the card header on every surface; the shared view's badge-row copy and the dashed "rubric hidden" note went with `AssignmentFeedback`.
- **What the gradebook pop-up now shows (Task 8, 23 Oct 2026).** It draws the card in view mode with Edit, so it gains everything the card has: Exempt reads "Exempt, rubric locked", the Flags pill is full size, the resubmit badge is the card's attention chip, the files chip sits in the card header, and Edit opens the editor in the modal. Closing the pop-up while in edit mode sends the card's queued draft save or delete as the editor unmounts, and refreshes the gradebook. The modal is 560 px, widened to 1100 px only while descriptors show; the overlay padding caps it to the viewport. On a phone it is a full-width bottom sheet, and a descriptor grid keeps a 640 px minimum (`.grade-card__rubric--descriptors > table`, in the `PHONE LAYOUT` block) and scrolls sideways inside its own box.
- **Student page data.** One request per course section: `GET /api/students/:id/grade-cards?courseId=` returns `{ course: { id, archived, excluded, writable }, cards: { [schoologyAssignmentId]: { assignment, topics, scoreScale, student, rubric, draft, hasDraft } } }`. Each card is `buildAssessmentView` (`server/services/assessmentView.js`, the builder behind `GET /api/mastery/:courseId/assignment/:assignmentId`) narrowed to this student, so no classmate's name, grade, work or count is in the response. The pop-up asks for its one task with `&assignmentId=`. Notes: the task set includes a dropped enrolment (the student page lists current enrolments only, the card must open for a student who left); `hasDraft` is true only while the draft is current (Schoology has not changed under it), as Triage's Unfinished grading counts it, so it is false for a dropped student and for an archived or excluded course (the stored `draft` is still returned); `rubric` is the task's attached rubric or null. Client: `getGradeCards` in `api.js`, `useGradeCards` (`assignmentId` option; `refetchOne` is ordered against full loads so a late answer never replaces a fresher card).
- **Comment:** the boxed `var(--bg-subtle)` block with a bold "Comment:" in view mode; line breaks are kept.
- **The student page carries this student's links (Graham, 18/10/2026):** in parent-teacher interviews he projects only the student's own page (/assessment/ shows other students' feedback), so each assignment shows the OneDrive **Open** link and the submission comments chip in the card header, as the modal does. Both load after the page renders and never block it, and both are fetched for this student only: `GET /api/students/:id/work-links?assignments=` returns only their link (files are still matched against the whole class, so a shared name matches nobody), and `GET /api/submission-comments/student/:id` returns only their summaries and queues a background read of their own threads, with one re-read later. OneDrive is asked three assignments at a time; each request lists them in one browser session (one sign-in instead of one per assignment), filling links in as answers arrive, and the page stops asking when there is no session or sign-in fails. A chip shows once the student handed in, the task is graded, or a read found comments: a chip on every untouched task was noise.

## PowerSchool alerts (October 2026, #117)

The alerts PowerSchool shows beside a student's name (accommodation plans, learning support, health, family), as badges. Present only when the `powerschool_alerts` feature is on (`PsAlertBadges`, `.ps-alerts`). **Hidden by default everywhere**, because both pages may be on a projector (a roster in class, a student page in a parent conference). Revised 18/10/2026 at Graham's request; the roster's rule was rewritten on 25/10/2026 (#160, below) and the student page's on 28/10/2026 (#185, below).

- **Plain badges, coloured by kind:** learning support and accommodations `badge-blue`, health (EpiPen, allergies, health care plan) `badge-amber`, other (mobility, elevator, no photo) `badge-gray`, family (correspondence G1 / G2 / G1+G2, divorced/separated, staff child, siblings) `badge-pink`. No red: an alert is information for planning, not an error or a destructive action.
- **Short, neutral labels written by Prism,** not PowerSchool's own names (which carry typos such as "Accomodation"): "Accommodation plan", "Learning support 2", "ILP", "Divorced/separated", "Staff child". The full name is in the hover title. They say a plan exists, never what it contains.
- **Student page: in place behind Private details, family alerts behind one more click (#185, Graham chose option A on 28/10/2026; mock https://claude.ai/artifact/Lt9Kcgv1ruhkhT2ny59fiP).** `StudentAlerts` (`client/src/components/StudentAlerts.jsx`) replaced `PsAlertReveal` and its **Show alerts (N)** button (18/10/2026 to 28/10/2026), which hid every alert until clicked even with Private details on. With the switch on, learning, health and other alerts show as chips under the name line, in the roster's tones with their full labels; a chip opens its detail under the chips (the roster pop-up's read, `GET /api/students/:id/alert-detail/:key`, drawn by the same `AlertDetail`; a learning alert answers with the Student Support Summary). One detail is open at a time; a second tap or **Close** shuts it, and nothing is kept on the page. Family alerts (correspondence, divorced/separated, staff child) stay behind **Show family alerts (N)**, never remembered: each page load and each other student starts hidden. Muted "From PowerSchool, read DD/MM/YYYY" under the chips. With the switch off nothing about the alerts is in the page.
- **Roster: behind Private details (#160, 25/10/2026).** The roster's own toggle (**PowerSchool alerts**, `prism:roster:show-ps-alerts`, #117) and its `getRosterAlertsShown` / `setRosterAlertsShown` helpers are gone. Alerts show on the Roster tab's cards as tappable chips (the same tones, short labels such as "Plan", "LS 1" and "AQHI: stay inside") only while the one **Private details** switch is on; a chip opens the alert's detail, read live from PowerSchool. See "Roster tab: Private details and projection safety" below for the switch and for everything else it hides.
- **Roster alerts are learning, health and other, never family** (unchanged): the API leaves family alerts out of roster data and the client filters again (`forRoster`, `client/src/lib/psAlerts.js`). The two AQHI alerts (6 or above, "AQHI: stay inside" and "AQHI: except events") are health alerts on the roster, in amber.
- **Hover:** each badge's title names the source and the read date ("EpiPen. From PowerSchool, read 17/10/2026").
- **Where alerts show (25/10/2026; student page revised 28/10/2026, #185):** the student page behind **Private details** (family alerts behind **Show family alerts**), and the Roster tab behind **Private details**, in its Roster, Needs attention and Test day modes (Test day lists learning plans only, never a health alert). Nowhere else: the Gradebook, Assessments and Analytics tabs, Search and Class Tools show none.
- **Guardian contacts behind the same reveal (#66, 21/10/2026; since #185 the reveal is **Show family alerts**).** With the feature on, each guardian on the student page carries PowerSchool's contact status, and the family facts stay behind the reveal. The reveal state lives in `StudentPage` and is shared by the family alert badges and the guardian cards (`StudentAlerts`' `familyShown` / `onFamilyShownChange`), cleared when the student changes.
  - **Deceased:** no card until the reveal; then the card with "Deceased (PowerSchool)" and the email as plain text. **Do not contact:** the name only until the reveal; then "Do not contact (PowerSchool)" and the email as plain text. A revealed card shows a phone as plain text, with no Edit.
  - **A flagged slot no guardian is matched to (the controller's ruling, 21/10/2026):** when PowerSchool flags Guardian N and Prism places no guardian uniquely in slot N, every guardian it could be takes that flag and is hidden the same way. A guardian placed uniquely in a slot keeps their own status. After the reveal the reason states why Prism could not identify them, then the flag: "Not matched to a PowerSchool guardian. Guardian N is flagged: Deceased (PowerSchool)" (the first part can also be "Not checked against PowerSchool yet" or "Matched to the same PowerSchool guardian as another parent"). The page shows the API's reason as sent.
  - **Not matched / not checked:** always visible, with a muted reason line ("Not matched to a PowerSchool guardian", "Not checked against PowerSchool yet") and the email as plain text. The extra phone stays editable, and no number on such a card is a `tel:` link. These say nothing about the family, so they need no reveal. With the feature on, a guardian sent without a status is shown as `not_checked`.
  - **No contact affordance on any guardian not cleared:** no `mailto:` link, no copy button (`.contact-email-plain`), so the address is never one click from an email.
  - **Primary contact:** a `badge-pink` label beside the name of a contactable guardian, always visible (Graham, 21/10/2026: the teacher needs it at once; it states who to email, not a family circumstance). *(28 Oct 2026: with PowerSchool's G1+G2 correspondence code both guardians carry it, and each matched contact has a small `G1` or `G2` tag (`.contact-slot`, popover "Guardian 1 in PowerSchool") right after the name, so the Correspondence G1 / G2 / G1+G2 alert reads against the right card.)*
  - **Show family alerts (N)** counts the family alerts plus the do-not-contact and deceased guardians, so it appears for a student with a flagged guardian and no other alert. Revealed with no alerts, it shows only Hide family alerts (no empty badge row, no alerts read date). (Until #185 it was **Show alerts (N)** and counted every alert.)
  - **Always visible, in neutral words:** **Copy all emails** copies contactable guardians only, with muted "N not copied" beside it when any with an email are left out, and is hidden when none is contactable. Under the heading, muted small "Checked against PowerSchool DD/MM/YYYY" or "Not checked against PowerSchool yet". "No parent/guardian contacts synced yet" shows only when the student has no guardians at all, never when every card is hidden.
  - **Class Tools, Email List:** the server leaves the same guardians out; the tool states "N guardians not copied" ("1 guardian not copied"), muted, beside the copy button.
  - **Feature off:** no status on any guardian, so the cards, Copy all and Class Tools are as before, plus the extra email, which is the teacher's own data and is shown and copied. The Schoology email and the teacher's phone show as before.
  - **Guardian details from PowerSchool (#173, 21/10/2026).** Graham's design: a guardian placed in a PowerSchool slot of their own shows that slot's email and phone; the Schoology email is the fallback. Each card lists the PowerSchool email, the PowerSchool phone, then the teacher's extra phone and extra email, each with a muted "Added in Prism" label (`.contact-added`).
  - **Edit is for the teacher's additions only.** An **Edit** button (`.ghost.accent`; a deceased or do-not-contact card has none) opens two inputs, "Extra phone" and "Extra email" (`.parent-detail-input`), with Save and Cancel. The PowerSchool values cannot be edited. PowerSchool supplies the details, so the extra fields are only for an address or number PowerSchool lacks.
  - **The extra email follows the guardian's status.** It is linked and copied only for a contactable guardian, and never for one Prism leaves out. A restricted guardian's extra phone and email, like their PowerSchool details, are plain text with no `mailto:`, `tel:` or copy button.
  - **An address a flagged guardian holds is never linked or copied for anyone else.** If a do-not-contact or deceased guardian holds an address, every other guardian's copy list leaves it out, in any linked row, and the card shows it as plain text, without a `mailto:` link or copy button. A guardian who has only this address still shows it, unlinked.
  - **A number a flagged guardian holds is never a `tel:` link on any card** (ruling of 21/10/2026). Numbers compare by their digits, so "5550-0100" and "5550 0100" are one number. The API sends the numbers a card may link (`contact.tel`); every other number is plain text.
  - **No detail is shown twice.** An extra email that is the address already shown, or an extra phone with the same digits as the PowerSchool phone, is left out. Copy all lists each address once.
  - **Class Tools counts guardians.** The "N guardians not copied" line counts guardians left out, not addresses. A contactable guardian whose every address a flagged guardian holds counts too, as on the student page.

## Sync dialog: time per phase (October 2026, #143)

- **One line per phase under "Finished in Ns":** the dialog foot's left column lists each phase that ran with its wall time (`.sync-foot-summary`, `.sync-timings`), in the phase-list order, mastery one line per course. Label left, time right in tabular figures, muted small text like the total, so it reads as a footnote to the result and not as a second phase list.
- **Shown only when the sync is done,** and only for phases with a recorded time, so a run joined from a log written before #143 shows the total alone.
- **Time format:** tenths under 10s ("8.5s"), whole seconds to a minute ("42s"), then "1m 3s" (`formatPhaseTime` in `client/src/lib/syncEvents.js`). Tenths keep a fast phase (blocks) readable as a number for the #108 lazy-or-eager decision.
- **Recent syncs shows the same list (#165).** An expanded run in Settings → Recent syncs puts a "Time per phase" list (`PhaseTimings`, shared with the dialog; `.sync-run-timings`) above its log, with the same lines, order and time format as the dialog, mastery one line per course. Above the log so it is seen without scrolling a long log; inside the expanded run, not on the collapsed row, so 30 rows stay one line each (the row keeps the total). Capped at 22rem wide so a label and its time stay close on a wide card.
- **Only for a run that stored its times.** The times are read from the run's own stored events; a run shows them only when it finished and its summary carries `phaseMs` (the same moment the orchestrator writes them to `sync_metrics`). A running or interrupted run shows nothing extra, and so does one logged before #143, even though its blocks phase was already timed: one line alone would read as the whole breakdown.

## Tag results across the course (October 2026, linked quizzes, #139)

A tag on the Questions tab opens that tag across every quiz group in the course, so a teacher can follow one learning objective over several tests. Counted over MCQs only, as the By tag table counts.

- **A drawer from the right, not a modal or a page.** `TagResultsDrawer` (`components/quiz/`) is a 720px panel over a light backdrop (`.tag-drawer`, `.tag-drawer__backdrop`), portalled to the body. The quiz stays visible to its left, so the teacher can check a question while reading the course figures. Close, Escape or the backdrop close it; Tab stays inside, and focus goes back to the tag that opened it (passed in, because Safari does not focus a button on click). On a phone it fills the screen.
- **Tags are buttons where they lead somewhere.** On the question rows and in the By tag table each tag is a `.tag-btn`: a badge gains a thin border (accent on hover) and plain text underlines on hover. The stored tag text stays in the hover title, with "Open this tag across the course" after it. Without a course (no drawer to open) the tag stays plain text.
- **One summary line, then By test, then By student.** "4/8 correct (50%) on 4 MCQs in 3 tests" with a `.pct-bar`. By test: number, title ("(this quiz)" and bold for the open one), the group's date (`formatDate`: the result task's due date, else the earliest member due date, else the first attempt), the tagged questions as "Q1 67%, Q3 33%" (each kept on one line), correct out of total and a percent bar. A group whose results are not loaded reads "Not loaded".
- **Students lowest first, so who has not met the objective is on top.** `ScoreDots` (the same dot plot as the MCQ summary) over a table: one column per test, headed by its number in By test with the title on hover, "2/2" per test sat, "-" (titled "Did not sit it") for one not sat, then the course total and percent.
- **Switch tags in place.** A Tag select at the top lists every MCQ tag in the course, most questions first, so the teacher can move between objectives without closing the drawer.

## Undo in the card comment box (October 2026, #75)

The comment box on an /assessment/ card writes its own value (a cleaned paste, the "resubmission received" line, Use suggestion), and that breaks the browser's own undo. The box now keeps its own history (`client/src/hooks/useUndoableText.js`, reusable for any box like it).

- **Keys, while the box has focus:** Cmd+Z undoes; Shift+Cmd+Z redoes. On Windows, Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y. The shortcut always stops the browser's undo, even with nothing left to undo, because its stack no longer matches the text.
- **Steps:** a paste, the chip line and Use suggestion are one step each. Typing is grouped: a typing step ends at a pause of one second or more, or when typing switches between adding and deleting text. After an undo or redo the caret sits at the end of the text that changed.
- **Boundaries:** Publish (the card's or Send all), Discard, and an Ask / Extend that rewrites the comment clear the history, so undo never brings back text from before them. No buttons: the box has no room, and the keys are what teachers try first.
- **Draft:** an undo is a change like typing, so the draft saver mirrors it.

## Late, the card header, cell corners and unread comments (October 2026)

Settled 17-18/10/2026 from the mockups (review page "Prism Filter Options").

- **Late qualifies a status; it is not a status.** `submissionStatus` puts `late: true` on the status it qualifies (a late flag with nothing to attach to shows nothing). `LateClock` draws it quietly, because students often submit just after the deadline and lateness is intel rather than an action: a small red clock on the corner of the status pill (card header, student page, rubric modal) and a tiny muted clock in a gradebook cell's top-right corner. Hover says how late ("1 h 23 min late", `lateText`).
- **Two sources, two marks (21 Oct 2026, #40, revised the same day after the live probes):** the outline clock is a late *submission* (`grades.late` and the submission time) and nothing else. The teacher's Late flag is Schoology exception **6**, which removes the grade like every other flag, so it is the red Late *symbol* (`FlagSymbol`) standing in the grade's place, never a clock. `LateClock` has no filled form and the hover has no "Marked late with Flags" line (both were built for the wrong assumption that Late is code 4 and keeps the grade). A flagged cell (any flag) keeps the outline corner clock when the submission itself was late, next to the symbol, so the flag does not hide that fact; the status pill reads a red "Late". Exception 4 is invalid in Schoology and labels nothing.
- **Card header, one home per kind of information:** beside the name, one status pill ("Resubmitted", blue, replaces "Submitted" once a resubmission has arrived) and the reason chips; on the right, buttons only (the amber "Ungraded resubmission" pill and the "Awaiting your feedback" sentence are gone). Any arrived resubmission rings the card blue. The "Resubmitted" reason chip is left out there because the status pill says it.
- **Shorter timeline:** DD/MM with no weekday, lateness in brackets ("Submitted 22/09 16:52 (1 h 23 min late)"), one "Resubmitted 16/10 14:28" in place of "latest ..." plus "Resubmission arrived ...". The assessment card leaves out the due date (`showDue={false}`) except an extension ("Extended to 25/09"); the page header shows the due date as its own outlined chip with a calendar icon.
- **Gradebook cell corners (layout A):** the level or status letter stays centred. Late clock top right. One comment spot bottom right: the submission-thread bubble (purple; amber when the student wrote; red dot while unread), else an outline bubble for the overall comment (it replaces the purple corner triangle). Hovering a cell shows the overall comment with whether the student can see it, plus a line about the thread. Clicking the thread bubble opens the submission-comments popover with the overall comment, read-only, at the top. OneDrive / Google Drive tasks have no threads, only the outline bubble.
- **Unread student comments:** a student comment with typed text or a file, newer than the newest comment seen when the thread was last opened in Prism (`submission_comment_seen`), is unread; automatic revision lines and the teacher's own comments never count. It shows as a red dot on the bubble and the card's comment chip, a red "New" tag on the comment in the popover, an **Unread comment** Needs action reason, and a count in Unfinished grading.
- **One comment signal on the card header (18/10/2026, chosen from three mockups):** the comment chip carries it. It turns amber when the student wrote text or attached a file (desktop and phone alike), and keeps the red dot while a comment is unread. The "Unread comment" reason chip and the "Wrote in comments" / "File in comments" text are gone from the header. The **Unread comment** pill stays in the Needs action filter, and the chip's hover text still names everything ("3 submission comments, the student wrote text, 1 unread"). Opening the popover marks the thread seen; the open thread keeps its "New" tags.
- **Sync reads the threads (18/10/2026):** a "Submission comments" phase in the nightly and manual Sync reads recent threads (current courses; dropbox tasks due or submitted in the last 30 days; OneDrive / Google Drive tasks have none), so unread comments show on every task, not only tasks opened in Prism since. Its time is recorded (`sync_metrics.comments_ms`) and shown in the sync dialog.

## Publish and unpublish on the Assessments tab (October 2026, #138)

Chosen 18/10/2026 from three mockups (state chip on every row, verb where it matters, both verbs always shown): option B.

- **Verb where it matters:** an unpublished row keeps its grey "Unpublished" badge and gains an outlined **Publish** button (`.publish-btn`). A published row shows a quiet **Unpublish** (`.publish-btn--quiet`) only on row hover or keyboard focus; on a touch screen it is always shown, in flow. Published rows otherwise look as before.
- **No room taken while hidden:** the quiet button floats over the row's right end (absolute, opaque card fill), so a hidden button never wraps a long title to an empty second line.
- **Confirm in a popover at the button** (24 Oct 2026; it was a bar under the row, which Graham found heavy, with the follow-through button far from the control): a small `.publish-pop` placed under the button (above it when the window has no room), holding "Students see it immediately." with **Publish** (`.primary.btn-sm`, focused) / Cancel, or "Students stop seeing it immediately." with **Unpublish** (`.primary.danger`). Escape or a click outside closes it. After the write, a green line "Published on Schoology (checked)." for 5 seconds; a refusal shows in the tab's `.alert.alert-warning`.
- **Live courses only**, like the make-up chip. The row shows the state Schoology read back after the write.
- **On the assessment page too, as a toggle (#184, 24 Oct 2026, Graham's choice):** the header shows a switch, "Published" or "Unpublished", beside View in Schoology (`PublishToggle`, `.publish-toggle`: a pill holding a small track and knob, accent when on). Flipping it opens the same popover confirm at the switch, then the same green "checked" line; a refusal shows as a warning there. Both pages draw the confirm and the line from `client/src/components/PublishTask.jsx`. Shown only where Prism can write (`course.writable`). Why: Triage's Unfinished grading counts every graded student on an unpublished task as feedback hidden, and its row opens this page, so the fix is one click from the reason.

## Remote sign-in to Schoology (October 2026, #136)

- **One sign-in path:** Settings → Schoology connection → **Log in to Schoology** opens `RemoteSignIn` inside the card. Every other "Log in to Schoology" button (Sync dialog, sync progress, archived courses, course page) goes to `/settings#schoology-signin`, which opens it at once (`client/src/lib/signIn.js`). Helper text: "Opens the sign-in here, on this device: a phone works too."
- **The picture is the page:** the server's sign-in (400 x 720 page pixels, portrait so it suits a phone) shown full card width, at most 420 px; a tap maps to page pixels. One line of instructions above it, including "At "Stay signed in?" choose Yes".
- **Typing:** one field, hidden by default (`type="password"`) with a **Show** tick box, then **Type it** (`.primary`). Font size 1rem so a phone does not zoom. Key buttons **Enter**, **Backspace**, **Tab** (`.secondary`) and **Cancel** (`.ghost`) on one wrapping row.
- **End states:** "Signed in. Prism saved the session." (`.alert-success`, Close) or a warning (closed, left too long, could not open) with **Start again**.

## Student Support Summary inside "Show alerts" (October 2026, #163)

*Superseded on the student page on 28/10/2026 (#185): the Support Summary is the detail of its learning chip, read when the chip is tapped (`AlertDetail`, the roster pop-up's rows), and `PsAlertReveal` with its `.ps-support-summary` box is gone. Kept below as the record of the 18/10 design.*

- **Only after the reveal:** when the student has the Support Summary alert, pressing **Show alerts** also reads the Student Support Summary from PowerSchool, live (10-minute server cache). Hide and show reads it again; nothing is kept on the page. A projector shows nothing before the click, as with the alerts.
- **Verbatim, full width under the badges:** a boxed list (`.ps-support-summary`, `var(--bg-subtle)`) headed "Student Support Summary, read from PowerSchool DD/MM/YYYY HH:MM"; each row is PowerSchool's Category and Description (`dt` / `dd`), the Support Plan URL as a link. Prism infers nothing, not even the extra time: it stays in Support Notes in PowerSchool's words. On a phone each category sits above its description.
- **States:** "Reading the Student Support Summary from PowerSchool…", "PowerSchool's Support Summary is empty.", or "Could not read the Support Summary: {reason}" in the amber warning colour. Never on a roster.

## Mastery freshness line (October 2026, #52)

- **Stored first, fresh after:** a page that shows mastery (course page, assessment page, each course on the student page) renders what Prism holds at once, then reads Schoology in the background (`useMasteryRefresh`). The server skips a read made in the last 2 minutes, so moving between pages does not re-read. Archived courses are never read.
- **One muted line** (`MasteryFreshness`, `.mastery-freshness`, 0.8rem, `var(--text-muted)`; on the course and assessment pages replaced by `SyncStatus`'s check line, #58), under the course header, beside the assessment page's Refresh from Schoology (now Sync Assignment), above the student page's Mastery Performance Summary: "Mastery levels as of 03:02 today. Checking Schoology for changes…", then "Mastery levels read from Schoology at 22:31 today." Times are "HH:MM today", else DD/MM/YYYY, HH:MM.
- **Failure:** "Could not refresh mastery levels from Schoology. Showing levels read at …" in `var(--badge-red-text)`, the reason in the tooltip; a sign-in failure adds **Log in to Schoology** (`.ghost.accent`, to Settings).
- **Never under the teacher's hands:** the assessment page swaps in newer data only when no card has unsaved changes. Otherwise an `.alert-warning` banner: "Schoology has newer levels or comments for this assignment. Save or discard your changes, then reload to see them." with **Reload** (`.secondary`). Unchanged Schoology data reloads nothing; only the time moves.

## Submissions and scores freshness line (October 2026, #108)

- **Same line, new subject:** `MasteryFreshness` takes a `subject` (`{ label, short }`); the triage and course reads pass "Submissions and scores": "Submissions and scores read from Schoology at 23:20 today.", "Could not refresh submissions and scores from Schoology. Showing submissions read at …". The mastery wording is the default.
- **Where:** at the top of the dashboard's triage rail (the rail reads its own tasks); on the course page, a second line under the mastery line (the page reads its triage panel's tasks plus its recent ones, and the rail does not read again).
- **One line per read,** not a merged line: each read has its own time and its own failure (mastery needs the saved session; submissions and grades mostly do not).
- **Replaces** the course rail's "Counts as of the last sync, …" line, which the read made stale.
- **The assessment page keeps one line** (mastery): its submissions and grades read runs with the mastery read and reloads the page with it.

## Sync controls and the "Synced" label (October 2026, #58)

- **Three names, three scopes:** **Sync Courses** (dashboard, Current tab; one click, no course list: it runs the nightly scope now, every current course with PowerSchool on, and opens the progress dialog; #171), **Sync Course** (course page), **Sync Assignment** (assessment page). Each syncs everything in its scope; there is no separate mastery sync.
- **The label is the point:** `SyncStatus` shows when the page last synced beside the `.primary` button, right-aligned in the header (layout and wording since #198: "Sync status: a small table with dots" below). The time is the last full sync of that course or task (`course_synced_at`, `task_synced_at`), never a background read.
- **One small line under it** for the page's own background reads (#52, #108): "Checked for new work at 10:05 today.", "Checking Schoology for new work…", or "Could not check Schoology for new work." in `var(--badge-red-text)` with **Log in to Schoology** when the session lapsed. It replaces the course page's two muted freshness lines and the assessment page's mastery line.
- **Sync Course runs in the sync dialog** (the same progress view as Sync Courses), so it shows each phase and survives a dropped connection; the button reads "Syncing…" while the dialog is open.
- **Phone:** the label and button sit at the start of the line (PHONE LAYOUT block).

## Sync status: a small table with dots (25 Oct 2026, #198)

Graham chose option 3 of three mocks ("Option 3 but with status dots"; mocks: https://claude.ai/artifact/NVUJ27v66fkQmEy2nNwpek). It replaces the purple time pill, the 0.78rem chip and the Blocks line padded under the whole row.

- **A small table** (`.sync-status`, a CSS grid; each `.sync-status__row` is `display: contents`): a status dot, what was read (muted), when (weight 600, right-aligned, tabular figures, so the times line up), then the "?". Rows: **Last successful sync**, and on the dashboard's Current tab **Blocks, calendar and alerts**.
- **One type size:** everything at the button's 0.85rem, the chip included.
- **Wording:** "Last successful sync" with "10:51 PM today", or "23/10/2026 at 10:51 PM" on another day (`freshnessTime`, 12-hour with AM/PM), or "none yet". The failed chip reads **Last sync failed**, so it is clear that only the last try failed, not that all data is out of date.
- **Status dot:** green (`--success`) when current, amber (`--warning`, with the time in `--badge-amber-text`) when a day old or never (the Blocks row: over 26 hours), gray (`--badge-gray-text`) for a past course, whose data is frozen and never amber.
- **Right column:** the Sync button on the first row, the chip under it on the second, the same width as the button's column.
- **An amber Blocks time** carries its action as an instant popover (`Tip`): "Press Sync Courses to refresh them.", which no longer sits in the line.
- **Phone:** the table sits at the start of the line and the button and chip take their own line under it (PHONE LAYOUT block).

## Background sync: one "Synced" time and a chip (October 2026)

- **One time per page** (Graham, 20/10/2026: "Confidence comes from not having to second guess the data"): `SyncStatus` shows only one sync time ("Last successful sync" since #198), the last time *everything* in the page's scope synced (Schoology data, every submission read, comment threads, mastery). The "Checked for new work" line and the muted mastery lines are gone. Amber when a day old or never; never amber for an archived course (frozen data).
- **A manual Sync button wherever synced data shows (Graham, 20/10/2026: it gives back some control):** the dashboard's Current tab (Sync Courses; the Archived tab shows its Synced time with no button, `SyncStatus label={null}`, since archived data is frozen and the sidebar button is gone, #171), the course page (Sync Course), the assessment page (Sync Assignment) and the student page (Sync Courses: the student's current courses, or their archived ones for a past student, and shown even before any grades). Background sync never replaces the button. Pages with no synced scope of their own (Search, People, Feedback, Tools, Import, Settings) have no sync button.
- **The chip** beside it while the page's background sync is queued ("Waiting to sync…"), running ("Syncing…", with the small spinner), failed ("Last sync failed" since #198, red outline) or held for a sign-in ("Log in to Schoology", amber fill). A rounded outline button (`.sync-status__chip`, weight 600, under the Sync button since #198); clicking it opens the progress dialog on that run (or the sign-in). The Sync button is disabled only while the chip shows a running sync: a press while a page sync waits goes ahead of it in the queue. A run a Sync button starts is followed by the same chip after its dialog closes (`SyncDialog onRun`). A scope whose last try failed within 10 minutes shows "Last sync failed" on that run instead of trying again at once. For a course scope, a failed task or quiz run does not count: only a failed course or full sync shows the chip (#170).
- **Where:** course page (Sync Course), assessment page (Sync Assignment), dashboard header on the Current tab (Sync Courses; the time is the oldest current course's), student page beside "Courses" (Sync Courses for that student's courses; the oldest of them).
- **The dialog** follows queued runs: "Waiting for the running sync to finish, then this one starts."; a held run shows "Waiting for a Schoology sign-in" with **Log in to Schoology**, and the dialog keeps following it, so a sign-in on another page or device lets it run on in the same dialog. On the assessment page the dialog does not reload the page itself: the page's own refresh decides, so an unsaved draft is never replaced.

## Freshness lines name the data, not the system (October 2026, #171)

- **Name the data, not the system behind it** (Graham, 20/10/2026): no freshness line or help text says PowerSchool or "Schoology's systems". The one exception is the help's last line, "Press Sync Courses only if you changed something in Schoology just now", which says where the teacher's own change was made. The progress dialog and provenance labels keep "PowerSchool".
- **A help "?" beside every Synced time** (dashboard, course, assessment and student pages; the Archived tab too): `SyncHelp` on the shared `HelpDot`, whose popover now takes children (an intro, two bold-labelled bullets, a last line). Bullet 1 is the page-open refresh (10 minutes); bullet 2 is "Blocks, calendar and alerts", refreshed every night when the night's refresh is on, otherwise when the teacher presses Sync Courses (on the dashboard) or says to press it on the dashboard (other pages). The "?" shows at once: until `GET /api/sync/status` answers (or if it fails), bullet 2 takes the night's refresh as off.
- **A past course's help says it is not refreshed** (final review, 20/10/2026): wherever the Synced time is an archived one (the dashboard's Archived tab, an archived course or assessment page, a past student's page), the "?" reads "Prism does not refresh past courses automatically." then "Open a course and press Sync Course to read it again." (dashboard), "Press Sync Course to read it again." (course page), "Press Sync Assignment to read it again." (assessment page) or "Press Sync Courses to read it again." (a past student's page): two lines, no bullets (`SyncHelp archived`).
- **The nightly line** (dashboard Current tab only; since #198 the second row of the sync table, "Blocks, calendar and alerts" with "3:01 AM today"). Amber, as the sync time, when the stamp is missing ("not read yet") or over 26 hours old ("N days old", N whole days, at least 1, "1 day old" singular). The 26 hours give a night's run some slack; the line is amber whether or not the night's refresh is on, so a missed night always shows.

## The first run: courses appear as they sync (October 2026, #171)

- **No setup screen.** On an empty database the dashboard starts the first run itself. A course stays off the dashboard until its first read finishes (`first_sync: 'pending'`), so a half-read course never shows; meanwhile a plain muted line above the cards (`.dashboard-progress`, `role="status"`) reads "Getting your courses: 4 of 12" (over the Current tab's courses, not excluded templates) and, while the run goes, the list is fetched again every 3 seconds (also when no course is listed yet).
- **A failed course still shows**, with a red "Sync failed" badge (`.badge.badge-red`, the first read's error as its tooltip), and stays a link to its page, where Sync Course tries again. A course is never silently missing: a pending course is hidden (and the line and the 3-second fetch run) only while the dashboard's background run is queued or running; a pending row with no run going (a run that stopped) shows as "Sync failed", and the server marks such rows failed at startup ("The sync stopped before this course.").
- **The empty state follows the run:** "Getting your courses…" while it is queued or running; "Your courses appear here once you log in to Schoology." while it waits for a sign-in (beside the "Log in to Schoology" chip); otherwise "No courses yet. Press Sync Courses to get your courses."
- **Past courses import in the background**, one at a time; the Archived tab shows "Importing past courses: 7 of 30" in the same `.dashboard-progress` style, checks every 5 seconds (also while the import waits to start during a run, and for 2 minutes after the run stops, since the import starts once its discovery ends; opening the tab reads the status again), and reloads its cards when the count moves. It runs once per install: when it is done the line is gone and the **Import archived courses** panel (hand-driven discovery) is all that is left on the tab.

## Suggestions made from old data (October 2026, #131)

- **One banner, not a line on every card.** A grading run writes every card from the same data, so the assessment page shows a single `.alert.alert-warning` above the cards: "AI suggestions were made from data as of 20/10/2026, 17:00. Sync Assignment, then grade again for current data." It names the oldest stale data time. If a stale suggestion was made before the task was ever synced, it says "AI suggestions were made before this task was ever synced. Sync Assignment, then grade again for current data." instead. This overrides the spec's "beside the suggestions", which would repeat one fact on every card.
- **Stale means over 10 minutes, measured when the grader was given its data.** A grader reads the context once, grades a whole class, and writes suggestions at the end, often over 10 minutes later, so write time says nothing. `get_assignment_context` records each answer as a serve (`context_serves`: the data time it served, `'never'` for a task not yet synced, and the moment it served it) and returns that serve's `context_id`; the grader passes the `context_id` of the answer it graded from to `write_student_suggestions`, and `upsertStudentSuggestion` copies that serve's times onto the suggestion as `feedback.data_as_of` and `feedback.suggested_at`. Without a `context_id` (or with one that no longer exists, which the result notes) the oldest serve of the task in the last 3 hours stands in, and with none the task's `task_synced_at` and now; a `context_id` of another task is refused. Serves are pruned after 30 days. A suggestion is stale when `data_as_of` is more than `SYNC_FRESH_MS` older than `suggested_at`, so a fresh sync followed by a late write is current, and stored data stays stale however a background sync stamps the task meanwhile. The server decides (`data_stale` on `/api/feedback/for-assignment`). `updated_at` is not used: it also moves when the teacher edits the row.
- **Only AI suggestions the teacher has not handled count.** A teacher's own saved grade never shows the banner, and neither does a suggestion marked used or ignored; revised ones still count. Rows written before these columns existed (null) are not judged.

## Feedback is reviewed on the assessment page only (October 2026, #122)

- **One place to review a suggestion:** the student's card on `/assessment/:id`, next to the rubric and comment it describes. The sidebar's "Feedback Review" entry and the `/feedback` page are gone.
- **Why:** two review surfaces for the same row let a status or an edit on one page go unseen on the other, and the standalone page had not been used since April 2026.


## Flag symbols and colors (October 2026, #40)

- **A flag is a symbol, never a chip (revised 21 Oct 2026).** Exempt, Late, Absent, Incomplete and Missing replace the grade in the gradebook cell (and the pop-up, student page and assessment card's score slot) with `FlagSymbol`: a round 18px disc with a 12px glyph and the flag's name under it in 8.5px bold capitals (`inline` size: 16px disc, 10px glyph, for text rows). Where it shows: the gradebook cell, its pop-up and the student page (the grade card in view mode), and the assessment card's status area (in place of the text status pill, with its name, 22 Oct 2026). Glyphs are inline SVG: Exempt a circle with a diagonal stroke, Late a clock, Absent a person beside a small circle with a diagonal stroke at its bottom left (as in Schoology), Incomplete a half-filled circle, Missing an exclamation mark. The first dashed `Exc` / `Inc` / `Miss` chips read too much like a level chip; a symbol cannot be mistaken for a grade. The popover reuses `.help-pop` (hover, focus or a tap; Escape closes) and holds the symbol beside the name, one guide line (`flagGuide`, e.g. "Left out of Sam's grade."), the reason line Prism wrote and, when Prism kept a copy of the grade, "Grade saved in Prism: Exhibiting (3.5). Clear the flag to restore it." In a gradebook cell the symbol is `passive` (hover only), because the cell is a `cell-open` button that owns click and focus and opens the same pop-up a graded cell does.
- **Flag colors follow Schoology, everywhere a flag shows:** Exempt green (`--flag-exempt`), Late red (`--flag-late`), Absent slate gray (`--flag-absent`), Incomplete amber (`--flag-incomplete`), Missing red (`--flag-missing`, the one outlined symbol: a white disc with a red ring), each with a pale `-bg` for badges and a white `--flag-glyph` for the solid discs. `EXCEPTION_TONE` in `gradeLabel.js` gives the flag badges (`SubmissionBadges`) the same tones (`slate` is new, class `badge-slate`), and the "Exempt, rubric locked" badge takes the flag's color too. Green is also the level EX and "Submitted"; the symbol and the words keep them apart.
- **Overdue is Prism's status; Missing is Schoology's flag (21 Oct 2026).** The red pill for past-due work with nothing submitted reads "Overdue" (kind `overdue`, gradebook letter **O**); "Missing" (its symbol) now means only Schoology's exception 3, so the two cannot be confused. The triage reason `referred_missing` keeps its wording, "Referred, not submitted".
- **`amber` status tone is `badge-amber`.** It was pink while nothing used the tone; Incomplete is the first user. (The card's status pill no longer draws a flag as text, so it no longer maps Incomplete's amber onto the filter tone `yellow`.)
- **Exempt is the only decision flag; Absent is a marker (Graham, 21 Oct 2026, reversing the ruling above it was first written under).** Code 1 means "not doing this task": never owed, late, referred, made up or waiting on feedback, no Extend button on the card, and setting it withdraws Prism's open records (`isExempt`, client and server). Absent (5) changes nothing in Prism's own tracking, because teachers use it differently ("their one chance" or "a reminder to follow up") and Prism assumes neither: no withdrawals, Extend stays, and make-ups, late work, feedback owed, the overdue clock and hidden feedback treat the student like an unflagged one. Incomplete, Missing and Late leave the work owed too. Absent keeps its symbol and slate color. The popover's first name is `preferredFirstName`.
- **Two final flags, three markers (Graham, 21 Oct 2026; built 22 Oct).** Exempt (1) and Missing (3) are final (`isFinalFlag`, `FINAL_FLAGS`): the card's rubric is grayed and locked with the "Exempt, rubric locked" badge, and they count as handled (`hasFeedback`, the feedback fingerprints, `gradingState`, `gradingStateOf`: feedback given, grading complete). Late (6), Incomplete (2) and Absent (5) are markers (`isMarker`): the rubric stays open with one quiet line above it, "Grading this work clears Late." (`.flag-marker-note`), the work stays in feedback owed and To grade until it is graded, and agent suggestions still stage. Publishing a grade over a marker clears it, as Schoology's own gradebook does: a scale score is sent with `exception: 0` (a score sent with a flag is removed), the rubric write clears it by itself, and Prism then retires the saved copy and takes the flag's status line off the comment. Over a marker, a rubric-only Publish sends a comment-free settle (`settleMarker: true`): Prism never writes the card's comment when the teacher did not change it, and the line comes off the fresh comment. Neither a score nor levels are written over a final flag (409 `FLAGGED`; a level write clears Exempt, Incomplete, Absent and Late in Schoology, probed 21-22 Oct; not probed under Missing), checked against Prism's row and a fresh read before the write. When the levels publish but the comment write after them fails, the card's error says so ("Levels published to Schoology; the comment was not saved (...). Publish again to send it.") and keeps the comment. Why: a marker is a note to the teacher, not a decision about the grade (spec "Decisions").
- **Missing's guide line names what the probes showed (22 Oct 2026):** "Scores this task as zero. Topic levels already entered still count." on an aligned task (`flagGuide(3, name, { aligned: true })`, `FlagSymbol aligned`), "Scores this task as zero." otherwise. Clearing Missing sends `grade: null`, so no 0 is left counting; that blanks the levels too, so Prism reads them fresh from Schoology, saves them into the copy first and offers them back.
- **What a flag does to the grade is said per flag:** Schoology removes the grade for Exempt, Incomplete, Absent and Late and counts Missing as zero (it keeps the levels); the rubric-hidden note and the lock badge's hover say which (`flagEffect`).
- **UI word "Exempt", never "Excused"** (Graham, 21 Oct 2026): the gradebook's own word on this account for code 1. Code 5 is **Absent** (prod already holds 13 rows of it). The timeline's submission line for code 1 reads "Exempt"; the PrisMCP state value stays `excused`, because it is a name clients may rely on.

- **Missing shows IE on the grade card (Graham, 21 Oct 2026; built 22 Oct).** On the student page and the gradebook pop-up (both the grade card in view mode since #176; `AssignmentFeedback` drew it before), work marked Missing shows IE on every topic, or every feedback row, when Schoology holds no levels for the task: the IE cell is the awarded one and carries a small Missing symbol (`FlagSymbol` code 3, `inline`, no name; `.rubric-cell-mark`), and one line sits above the rubric beside the named symbol, "Shown as IE because the work is marked Missing. Schoology holds no topic levels for this task yet." When levels do exist (Missing set over graded work) they show as they are, with no per-cell symbol, under "Marked Missing. These levels still count in the topic averages." A feedback-row task's row levels live only in Prism, so its lines say that instead (#40 review, 22 Oct): "Shown as IE because the work is marked Missing. No rubric rows are scored for this task yet." and "Marked Missing. These are the rubric rows Prism holds for this task." It is a display transform (`missingView`): nothing is written and the student page's per-topic summaries keep Schoology's own numbers; recording real IEs in Schoology is #175. The gradebook cell is unchanged; the assessment page's card draws the same IE display (#176).

## The Flags menu and panels (22 Oct 2026, #40)

- **One Flags pill, in the style of Schoology's gradebook button** (`FlagsMenu`, `.flags-pill`). It sits in the card header after Refer and before Extend, and, smaller (`size="sm"`, `.flags-pill--sm`), in the card's header in view mode (the gradebook pop-up and each task on the student page, on a current course only). Closed it reads "⚑ Flags ▾" with an accent outline, like the other header pills; with a flag set it shows the flag's disc (`FlagDisc`, no popover inside a button) and name, filled with the flag's pale color and a 2.5px ring in the flag's color (`--flag-c` / `--flag-c-bg`). Missing stays outlined on the card color, as its symbol is. Open (`aria-expanded`) it takes the selected look the other header pills use.
- **The menu** is a fixed dropdown under the pill (`.flags-menu`, z-index above the pop-up's overlay; placed in script so neither the card nor the pop-up clips it, kept inside a 16px gutter at phone width; above the pill when the room below is too small, and scrolling inside itself when neither side has room, 23 Oct 2026, #174): the small-capitals subheading "Flag in Schoology", the five flags in `FLAG_ORDER` (Exempt, Late, Absent, Incomplete, Missing), each a disc, its name and its `flagGuide` line with the student's preferred first name, then a divider and the note "On graded work, Schoology removes the grade while a flag is set. Prism keeps a copy and offers to restore it when you clear the flag." The set flag is ticked (accent ✓, `aria-checked`) and its line reads "Choose again to clear it." Keyboard: focus starts on the ticked flag (else the first), arrow keys move and wrap, Home/End jump, Enter or Space chooses, Escape (or Tab) closes and gives focus back to the pill; a click outside or a scroll closes it.
- **Choosing reads Schoology first.** The pill is disabled while the fresh read (`GET /api/grade-flags`) and any write run, and stays so until the page has refetched the pair. If the fresh read differs from what the page shows (flag or score), nothing opens: "Changed in Schoology since Prism last read this task. Sync, then try again." beside the pill. Every failure shows there in `--danger` (`.flags-error`, `role="alert"`), and the pill keeps its previous state.
- **The panel** (`FlagPanel`) opens in the card's action-panel row (the slot Extend uses), which is the same row in view mode. Title "Mark Sam exempt?" (the flag's verb). One field, "Reason for the student (optional)", with a live preview under it once a reason is typed: `Added to the top of Sam's comment: "Marked exempt on Thu 22/10. <reason>"` (today, `lineDate`, the reason made plain ASCII as the line will be). Then, in this order: "Also withdraws: Extension to Fri 24/10/2026" (Exempt only, when Prism holds open records); the saved-grade note on graded work as an amber note (`.flag-panel__saved`), "Schoology removes this grade while the flag is set. Prism keeps a copy: 75 / 100 and 2 topic levels. Your comment stays." (Missing: "Schoology sets this grade to 0 while the flag is set. ..."); a marker's next steps (Late, Incomplete, Absent, verbatim from the spec); then "Cancel" (`.ghost`) and "Mark exempt" (`.primary`). A flag that replaces a flag opens the same panel; when the grade is already in a waiting copy, the note names that copy.
- **The grade in words** comes from the server, one helper for every surface (`server/services/savedGrades.js` `gradeSummary`): a score-scale level with its points ("Exhibiting (75)"), else the points ("87.5 / 100"), then "N topic levels" and "N rubric row levels". The spec's "Exhibiting (3.5)" was a placeholder; Prism's scales are on points out of 100.
- **Clearing** the ticked flag with a copy waiting opens `ClearFlagPanel`: "Clear Exempt?", one box ticked by default, "Restore the saved grade as a draft: 2 topic levels" (what the card can stage; "(replaces your current draft)" when the card has one), "Re-enter in Schoology: 90" for the parts it cannot (a points-only score, an overall typed over the computed one), and "Cancel" / "Clear Exempt". With no copy, choosing the ticked flag clears at once and never restores (`restore: false`): a copy that clear keeps (clearing Missing set in Schoology over levels) is offered on the card instead. A restored copy is staged on the card as a draft (the pending count shows it) and goes to Schoology with the usual Publish. Prism never replaces a teacher's draft unannounced (review, 22 Oct 2026).
- **The card after a write:** the page refetches that student only (the other cards keep their drafts), the comment editor takes the comment Schoology now holds (an unsaved edit keeps the teacher's text, with the flag's line swapped on top), and the flag's symbol shows in the status area (`SubmissionStatusPill` draws the symbol with its name instead of a text pill, with the popover). A final flag's locked rubric draws the saved levels grayed (and a score-scale task's saved overall level), with the caption "Saved before the flag on Wed 21/10. Clear the flag to restore it." above it (`.flag-saved-caption`). With no flag set and a copy still waiting (cleared with the box unticked, or kept by a clear with no panel), a quiet line above the rubric says what it is, when it was saved and what a restore puts back: "Grade saved in Prism on Wed 21/10: 75 / 100 and 2 topic levels. Restoring puts back 2 topic levels as a draft.", with a `.ghost.accent` "Restore saved grade" (or, when nothing can be staged, the parts to re-enter in Schoology instead of the button). Over staged changes the button asks first, inline in the card (no browser dialog): "Restoring replaces your draft on this card with the saved grade (2 topic levels)." with `.primary` "Restore and replace your draft" and "Cancel". A copy is retired (no longer offered) by any published score or levels for the pair, flag or not: a newer grade makes it stale.
- **A final flag keeps staged levels as a draft (revised 22 Oct 2026, #40 review).** When Exempt or Missing lands on a card, its staged topic, row and overall levels stay in the card's draft (the comment and Display edits too), and one quiet line under the lock says so: "Your staged levels stay as a draft until the flag is cleared." (`.flag-marker-note`). Dropping them, the first build, lost the teacher's work for a flag that may be cleared the same day.
- **A final flag publishes the comment only (22 Oct 2026, #177).** With Exempt or Missing set and levels staged, the card's publish button reads "Publish the comment only": it sends the comment and Display, and the staged levels stay as the draft. It is disabled when only levels are staged. Publish all counts only cards it would send ("Publish all to Schoology (N)"); Discard all and "N students with unsaved changes" still count a card that holds levels, and the result line names each one: "Levels kept as a draft until the flag is cleared: Grace H (Exempt)." Before this, the teacher had to discard the comment edit or clear the flag to publish a comment.
- **A flag's reason warns over a hidden comment (22 Oct 2026, #40 review).** A reason writes a status line, and publishing a line turns Display on, so when Display is off and the comment holds the teacher's own text (not only Prism's line), the Flags panel shows the same warning as Extend and Resubmit (`HiddenCommentWarning`, exported from `StatusLineModal.jsx`): "Their comment is hidden from the student. Publishing turns Display on, so your current hidden comment becomes visible to the student and parents. Edit or remove it in Schoology first if it isn't for them." The modal's form adds "(below)" and the re-read button. Publish all never sends levels for a student on a final flag (revised 22 Oct 2026, #177: see the next entry); the server's `FLAGGED` refusal stays as the backstop. Any error after the Schoology write (a read-back mismatch) still refetches the pair, and a failed refetch says "Saved, but the page could not refresh. Reload to see it." beside the pill.
- **The gradebook and the student page** refetch after a write (the gradebook, its topic levels and the triage panels; the student page and each course summary), and the open pop-up redraws from the fresh data. A flagged cell's symbol, the pop-up and the student page pass the saved grade in words (`saved_level`) and the flag's reason line (`flag_line`) to the popover. Where the card has the Flags pill, the pill carries a set flag, so the header drops its text flag badge (an archived course, with no pill, keeps it).

## Flag for review removed (21 Oct 2026, #40)

- **Graham dropped it completely.** The card header pill, its reason field, the "Review: ..." badge on the gradebook pop-up and the student page, the "Flag for review" refine pill, the "Flagged for review" Needs action reason and the "flagged" count in Triage's Unfinished grading all went, with the `flags` table (`DROP TABLE IF EXISTS flags` in `MIGRATIONS`) and `/api/flags`. The 8 stale automatic "Below 50%" flags in prod went with the table.
- **Kept, because they are different things:** the AI suggestion's reviewer flags (`reviewer_flags`, `reviewer_flags_brief`, the amber "Reviewer flags" tray) and the Ask to resubmit request (built from the `resubmissions` table; the student page still lists open requests under `flags`).
- **The card header slot went to the Flags menu** (all five flags; see "The Flags menu and panels" below), which sits after Refer and before Extend in the right-hand cluster.


## Archived Import list: section titles (#178, 23 Oct 2026)

- **Each row names its sections:** the course title, then its section titles in the muted text color (`.archived-import-section`), so two sections of one course can be told apart ("TEACHING ASSISTANT (YR) 2(A-B)", "... 7(A-B)"). A linked set is one row listing every section ("4(A-B), 6(A-B)").
- **"import failed twice"** is a gray badge, like "no course code": the background import gave up on that section, and the row is how to import it by hand.
- **No sign-in prompt:** the list comes from Schoology's REST section list, which needs no session. A failed read shows "Schoology could not be read. Try again in a few minutes." in the panel's warning alert.

## Triage's Flags panel (#174, 23 Oct 2026)

- **A list to empty.** "Flags" sits in the Triage rail with the clocked panels and is ordered with them by its worst row. It is hidden on a fresh load with no rows, as Resubmissions is; once it has shown rows it stays, so the row just handled ends on "No flags waiting on you."
- **Subheading:** "school days since flagged, semester ends 11/12/2026" (the end only when every row shares it). Badge: "N urgent" (red rows), `badge-red`.
- **Each row:** the `UrgencyRing` (day 1 = the flag date; the ring's limit is the semester end), the student's name linking to their card on the assessment page, the flag's disc (`FlagDisc`, none for a saved-grade row), an amber "Submitted after the flag" tag when it applies, the course line on the Dashboard, the task, then one advice line in muted text (`.triage-row__advice`), verbatim from the spec. The advice is neutral; Absent's names both usual next steps.
- **The row's control is the card's Flags menu, compact** (`FlagsMenu compact`, `.flags-pill--compact`): the set flag's disc (or ⚑) and the caret only, with the full title as its accessible name, per Graham's request for "an icon instead of the full text". Its panels open in the row's own host under the text (`.triage-row__flag-panel`, hidden while empty). Grading stays on the card.
- **Color by semester, not by age:** green, then amber over the last 10 school days of the semester that contains the task's due date, red over the last 5 and after it. A row from an ended semester stays red; it never turns green when the next semester starts.

## The Refer panel (#175, 23 Oct 2026)

- **Refer on missing work confirms first,** because it now writes to Schoology. `ReferPanel` opens in the card's panel row (and below the row in Triage's Overdue work): the title "Refer to the academic office?", one box, ticked by default, "Also record IE on every topic and mark Missing in Schoology", a muted line under it while ticked, then Cancel and a red Refer (`primary danger`, as the Triage row's Refer). A refusal shows in the panel, which stays open.
- **Handed-in work keeps the one-click Refer:** nothing is written to Schoology there.
- **Undo mirrors it:** on a referral that wrote Missing (and Missing still set), Undo opens the same panel, "Undo the referral?", with "Also clear Missing and the IE levels in Schoology", ticked. Otherwise Undo acts at once, as before.
- **Reuses the Flags panels' parts** (`.flag-panel__check`, `.flag-panel__line`) rather than a new modal: the action is one decision with one option.

## Class Tools: past courses and roster filters (#73, 24 Oct 2026)

- **Past courses sit under their own toggle,** below the current and hidden courses: a `.ghost` button "▸ Past courses (N)", with `aria-expanded`, closed by default, adding ", N selected" while any is ticked so a ticked course never hides. Open, the list groups by school year (`groupByYearAndSemester`), newest first. Empty past courses are left out, as current ones are.
- **Select all ticks the current courses only** and keeps any past course already ticked: past courses are opt-in, one at a time.
- **The filter bar is a card above the tools,** closed by default ("▸ Filter students"), so the page looks as before until a filter is wanted. It always states the roster size ("52 students"); with a filter set, "Showing 18 of 52 students" in bold and a Clear filters button, even while closed.
- **One row per filter** (Gender, Grade, Overall proficiency), each a `role="group"` of `.filter-btn` pills with `aria-pressed` and the count in brackets ("Female (12)"). Pills list only values some student holds, plus the no-value pill: "Not known", "No grade", "No levels yet". Level pills show the code (ED, EX, D, EM, IE), with the full name as the title.
- **Every tool reads the filtered roster.** A list, pick or set of groups made before the courses or filters changed is cleared, so nothing on screen belongs to another selection.

## Roster tab: Needs attention (#160, 25 Oct 2026)

- **Triage grouped by student, not a second triage.** With Private details on, "Needs attention (N)" lists the students who owe something in this course, each as the Roster card with its triage rows under the card's thin divider (`.roster-card__items`), then "Everyone else (N)" as plain cards. The rows are triage's own (`client/src/lib/needsAttention.js` `studentRows`), so the rail and the roster cannot disagree. Off, the mode is the locked box only.
- **Which rows:** overdue work, late work handed in at the limit, make-up tests, resubmissions asked for and not arrived, and the Incomplete and Absent flags. Feedback owed, Unfinished grading, arrived resubmissions and the Missing, Late and saved-grade flags are Graham's own grading, so they stay in the rail.
- **Each row** (`.roster-attention-row`): the rail's `UrgencyRing` (its numbers and tones), the kind in words ("Overdue", "Late, handed in", "Make-up test", "Resubmission pending", "Resubmission overdue", "Incomplete", "Absent"; red when the row is), the flag's `FlagDisc` on a flag row and beside overdue work that Schoology has flagged Missing, the task title as a link, and one muted line in the rail's words ("7 school days late, 1 left", "at the limit", "last day").
- **The rail's actions and rules** (`useTriageActions`, shared with `TriageSection`): Refer (opens `ReferPanel`) once overdue work is at the limit, Extend (the `ExtendEditor` under its row) and Email; Refer and Waive for work handed in at the limit; Extend and Email for a make-up; Email for a resubmission; Email and the compact `FlagsMenu` for a flag row. Email is the row's `MailLink`, drawn as a small outlined button (`a.roster-attention__email`).
- **A done row stays where it was** with what was done ("Referred", "Referral waived", "Extended to DD/MM/YYYY") and Undo, even after triage drops it, so Undo is reachable and nothing jumps; it goes when the mode is left.
- **A tap among the rows never leaves the page.** The rest of the card still opens the student page.
- **The task link** opens the task with `?student=` and `?filter=action`: the Needs action row selected and the card in view (the page clears the filter when that card is outside it).

## Roster tab: the card (#160, 25 Oct 2026)

Design: `docs/superpowers/specs/2026-10-25-course-roster-redesign-design.md`. The Roster tab (`client/src/components/roster/`) replaced the old roster table (`RosterView`, deleted) with four modes under the course header: **Roster**, **Needs attention**, **Test day** and **Mastery** (`.roster-modes`, `.tab-btn` until #194 made them the child row `.subtab-row`, `.subtab-btn`; the mode is remembered like the course tabs, `?mode=`). All four always show, so the teacher can see what exists.

- **One card per student** (`RosterCard`, `.roster-card`), in the Sort by order (last name by default); tapping the card opens the student page, and a button or link inside does its own job only. Left: the photo (initials when none), then the **name line**: the name in a large weight, alone on its line (`.roster-card__nameline`). Since 27 Oct 2026 the card shows no gender or age tag (see "Gender and age on the student page only"). Under it one muted line: `Grade 11`, the student number and an **Email** copy button, separated by small CSS dots (`.roster-card__meta`: the dot trails the item before it, the timeline's pattern, so a wrapped line never starts with one), e.g. a grade, then 27130, then Email. The student number is the email's local part; no email means no number and no copy button.
- **Gender as a tag, not a word (Graham, 25 Oct 2026; superseded 27 Oct, when the tag moved to the student page):** the tag group's only tag today is the gender code, placed on the name line (it moved there from the meta line, which is back to grade, number, Email) so the card gains no height. The code is `F` (Female), `M` (Male), `NB` (any value other than F or M that PowerSchool sends; the popover quotes the stored value exactly, "Recorded in PowerSchool as \"X\"", so the roster never assumes what it means, Graham, 25 Oct 2026) or `?` (Not recorded in PowerSchool: a blank or missing value); one helper, `lib/genderTag.js`, maps a raw value to `{ code, label }`. A tag is `.roster-tag` (0.68rem, muted text on `--bg-subtle` with a `--border` outline, no new colours). The name shrinks first (its ellipsis) and the group never wraps under it (`flex: none`). The group is built so age (#191) can be added later as its first tag. A tag is keyboard focusable, its `aria-label` is the full label, and hover, focus or a tap shows the full label in the shared instant popover (`.help-pop` through `useHelpPop` in `HelpDot.jsx`), not a native `title`. A tap on a tag does not open the student page. With Private details off the group is not in the DOM. Class Tools (#73) keeps its own words (Female, Male, Not known).
- **One name per student:** `preferredFirstName` + `last_name`. The legal name (the old roster's bracket after the name) appears nowhere on the Roster tab. The grade, the Email and Grade columns, and the per-category cells of the old table are gone: the grade lives in Mastery.
- **Right of the name, Private details only:** the unread comments count (`.roster-stat`: the number large, the word small; tap to read, `.roster-pop`) and the alert chips, in fixed-width slots (7rem and 12rem) so they line up down the page. With the switch off those slots are not drawn at all. No on-time rate and no overdue count on the card: overdue work is in Needs attention.
- **Alert chips** (`button.roster-alert-chip`): the `PsAlertBadges` tones (learning blue, health amber, other gray) with short labels ("Plan", "LS 1", "AQHI: stay inside"); the full name and detail are in the pop-up. A learning alert opens the Student Support Summary as a two-column table (Category, Description); another alert opens its detail read live from PowerSchool; where Prism can read nothing it names the alert and says so.
- **Pop-ups** (`AnchoredPopover`, `.roster-pop`): fixed, portalled, inside a 16px gutter, above the anchor when there is no room below, scrolling inside themselves; Escape or a click outside closes; the anchor toggles its own pop-up and another anchor replaces it. Switching Private details off, or changing mode, closes any open pop-up. The comments pop-up lists a student's unread comments oldest first with **Open the task in Prism**; it marks nothing read.
- **Needs attention** is documented in "Roster tab: Needs attention". **Copy emails** is a pop-up (`CopyEmailsPopover`): whose emails (Students or Guardians), the two Class Tools formats, a read-only preview, **Copy N emails**; guardians follow Class Tools' rules for do-not-contact and deceased.

## Private details across Prism (#197, 25 Oct 2026)

Graham decided on 25 Oct 2026 that one switch covers the whole app: any page may be projected, not only the roster.

- **The switch** is **Private details**, a full-width row in the left sidebar under the logo (`PrivateDetailsSwitch`, `button.private-details-switch`, `client/src/components/PrivateDetails.jsx`), with an eye icon and **On** / **Off**. **Amber while on** (`aria-pressed`), so a projected screen shows immediately whether it is safe. Its help is the instant popover on hover or focus; a tap only switches. On a phone it sits in the menu drawer, and the top bar shows its state (`PrivateDetailsState`, `.private-details-state`, a status chip, not a second control). One `localStorage` key (`prism:private-details`) on this device, read and written in try/catch, **default off**; storage that is unavailable means off and the choice is held in memory for the page (`client/src/lib/privateDetails.js`, `usePrivateDetails`). It replaced the Roster tab's own pill (#160, beside the course name) and, before that, the roster's "PowerSchool alerts" toggle.
- **One marker wherever content is withheld:** the `PrivateHidden` box (`.private-hidden`, `--bg-subtle`): a bold line with the eye-off icon naming what is withheld ("Grades are private.") and "Turn on Private details in the side menu to see it. It stays hidden so the page is safe to project." Hidden means not rendered: the private parts are absent from the DOM.
- **What follows it:**
  - **Dashboard:** the triage rail holds only the box; the course cards drop their triage line and tone edge; the "At a glance" strip keeps its status line (school day, last sync, Schoology) and drops the overdue tiles. Triage is still fetched, for the school day.
  - **Course page:** the Gradebook, Assessments and Analytics tabs show only the box; the triage rail holds only the box; the **Triage ▸** button's red count shows only with the switch on, on every tab.
  - **Assessment page:** the way back to the course and the box; the page itself unmounts (each grade card in edit mode saves its draft as it unmounts) and turning the switch on mounts a fresh page that reads the task again.
  - **Student page:** photo, name and the line under it (grade, student number, Email; #185) stay, with Recent tasks; alerts, family contacts and notes are replaced by one box in the contacts column ("Alerts, family contacts and notes are private."). **The courses, with every grade card, level and comment, show with the switch off too** (Graham, 27 Oct 2026): the page is one student's own record, the one shown in a meeting with that student or family. Class-wide grades (the Gradebook, Assessments and Analytics tabs, the assessment page) stay private (Graham confirmed, 27 Oct 2026: they show every student's grades on one screen), and the switch's help states the exception. A grade card's comment and file chips open their content with the switch off. The gender tag stays private.
  - **Roster tab:** below.
- **Class Tools (Graham, 25 Oct 2026):** the tools stay, since they are made to be projected; the filter card (gender, grade, overall proficiency) is replaced by the box and no filter applies, and a balanced group leaves out each student's percentage. Search and the Directory are unchanged.

## Roster tab: Private details and projection safety (#160, 25 Oct 2026)

A roster may be projected to a class, so everything private on the Roster tab follows the app-wide switch (above).
- **What it hides, by being absent from the DOM, not hidden by CSS:** comment counts, alert chips, the filters, Copy emails, the triage count on the rail's button, and every student in Needs attention and Test day, and every level and grade in Mastery. Switching it off also clears the filters and closes any pop-up. Client tests assert that with the switch off no private value is in the page (`RosterTab.test.jsx`, `TestDay.test.jsx`, `MasteryView.test.jsx`).
- **What stays visible with it off:** the cards (name, photo, grade, student number, Email), the mode tabs, and Test day's test picker and length. Each private mode shows the shared `PrivateHidden` box in place of its content (#197; it was `.roster-locked`).
- **The rail follows the switch on the Roster tab (#192, Graham 25 Oct 2026):** shown by default while Private details is on, not in the page while it is off; **Triage ▸** toggles it either way. A tab change, or turning the switch on or off, returns to that default, so a rail opened on Gradebook does not follow the teacher to the Roster tab. The red count on the **Triage ▸** button is drawn only with Private details on (the count is itself private).
- **Roster alerts are learning, health and other only, never family** (`forRoster`, and the API leaves family alerts out). Missing Health Form, Early Dismissal and Library Alert stay out; the two AQHI alerts are in.
- **The student page** follows the same switch since #185 (28 Oct 2026): its learning, health and other alerts show in place, and only its family alerts wait behind **Show family alerts**, never remembered (see "PowerSchool alerts").

## Roster tab: layout and container queries (#160, 25 Oct 2026)

- **One width, rail or no rail (#192):** on a current course's Roster tab the main column keeps the width it has beside the 380px rail (`.triage-layout--fixed-main`), with the rail shown or hidden, so the cards never spread across empty space. A phone stacks the rail below as before (`PHONE LAYOUT` resets the width). `check:mobile` measures the column with and without the rail at 1100px.
- **Sub-tab names:** the first mode is **Details** (Graham, 29 Oct 2026). It was **Details and Attendance** from #192 ("Roster" repeated the parent tab, and attendance entry was meant to go there) until attendance got its own course tab (#39).

- **The roster answers its own width, not the device's.** The same page is full width, beside the triage rail, or on a phone, so `.roster-tab` is a size container (`container: roster / inline-size`) and the cards' rules are `@container roster (max-width: ...)` queries in the ROSTER section of `client/src/app.css`: 760px (Mastery's class cards move the grades beside the categories and the column header becomes one line), 640px (Mastery's one-category rows stack the name above the chips and the headings show codes only), 600px (the private slots move under the name; Test day and Needs attention rows stack), 480px (Mastery's chips shrink). This is a **new pattern** in Prism (the triage panel's `@container triage-panel` was the first small use). It means a rule can follow the room it is given; it does not replace `PHONE LAYOUT`.
- **Device rules stay in `PHONE LAYOUT`** (the drawer, tap targets, the top bar). A rule about the roster's width goes with the roster's styles; a rule about the device goes in the one `@media (max-width: 768px)` block.
- **No sideways page scroll** at 390px or 1100px in any mode. `npm run check:mobile` opens a course's Roster tab with Private details on in all four modes (and Mastery's one-category layout) at both widths and asserts `scrollWidth` equals the window's width. Mastery's one-category header is `position: sticky`, so nothing around it sets `overflow`; the columns shrink instead.

## Roster tab: filters (#160, 25 Oct 2026)

- **Reused, not copied.** With Private details on, the filter bar is built from the assessment page's controls (`.assessment-filter-bar`, `.assessment-filter-row`, `button.filter-btn`, `.assessment-filter-status`, `button.filter-btn-clear`; see "Assessment page filter controls"). The group pill is now a shared component, `client/src/components/GroupPill.jsx` (`GroupPill`, `groupState`), used by `AssessmentFilterBar` and `RosterFilters`, so the empty box / dash / tick states cannot drift.
- **Rows:** **Alerts** (group pill with the count of students holding any alert, a divider, then one pill per alert type some student holds, with its count; learning alerts share one **Learning plan** pill) and **Follow up** (the muted group pill, then **Unread comments**; #39 adds absences here). A pill shows only while some student matches it or it is on. Alerts and Follow up pills combine as "any of".
- **Gender row (25 Oct 2026):** a third row, built from the same `GroupPill` and `.filter-btn` pills as Alerts and Follow up: **Gender** (the count of students shown, every active student), then the codes **F**, **M**, **NB** and **?** (same meaning as the card's tag, 25 Oct 2026; the NB pill's popover quotes every distinct stored value), each with its count and each shown only while some student matches it or it is on. A pill's `aria-label` is the full label and count ("Non-binary, 2"), and hover, focus or a tap shows the full label in the same instant popover. Gender is an attribute, so the row **narrows** (as the assessment page's Refine pills do): within the row the pills are "any of" (F or M), and the row combines with Alerts and Follow up as AND, so F with Learning plan shows only the girls who hold a plan. With no Gender pill on, behaviour is as before. Its keys (`gender:F`, `gender:M`, `gender:NB`, `gender:none`; none is the `?` pill) share the one selection set; `applyRosterFilters` splits them out. Dropped students are never counted. Private details only, like the rest of the bar.
- **Status line:** "Showing 4 of 12 students" (or "Showing all 12 students") with **Copy emails (N)** beside it, and a red-outlined **Clear all** at the right while any filter is on. Filter state is per course and per visit, not remembered.

## Roster tab: sort (#160, 25 Oct 2026)

- **"Sort by" above the Roster mode's cards** (`RosterSort`, `.roster-sort`): **First name**, **Last name** and, with Private details on, **Gender**, as the bar's own `.filter-btn` pills with `aria-pressed` (the active one filled). No new colours. Default **Last name**. It sits below the filters, so the filtered list is what gets sorted; the revealed dropped cards follow the same sort. The control is not drawn when no student is enrolled. Needs attention keeps its urgency order, Test day its order, and Mastery its own sort; the control is not drawn in those modes.
- **The names are the ones the card shows** (`preferredFirstName` + `last_name`), compared ignoring case and accents; a tie breaks on the other name. **Gender** puts F first, then M, NB and ?, each group by last name.
- **Remembered on this device,** one `localStorage` key (`prism:roster:sort`) for every course, read and written in try/catch, held in memory for the page when storage throws (`client/src/lib/rosterSort.js`, the same pattern as Private details). A stored **Gender** with Private details off sorts by last name and leaves the stored value, so turning the switch on again restores it.

## Roster tab: Test day (#160, 25 Oct 2026)

- **Picker and length are public; the list is private.** The test picker (the course's published tests due in the next 14 days, nearest first and chosen by default, plus **No test (plans only)**) and a `NumberStepper` for the length in minutes (5-minute steps, starting at 50) show with Private details off. The students show only with it on.
- **Minutes, not clock times:** Prism holds lesson dates but not bell times, so a card says "63 minutes, 13 more". *(Since #187, 27 Oct 2026: clock times too, when the class meets on the test's date; see "Test day clock times".)* **With no test chosen the percentage leads (#192):** "50% extra time" prominent, and under it, muted, the example for the chosen length, "75 minutes for a 50-minute test". With no test in range, a dashed box (`.test-day__none`) says "No test is set in the next two weeks."; when tests exist and **No test** is picked it says "No test chosen." (the other sentence would be false there).
- **The card** (`.test-day-card`): photo, then the name and the plan names in a fixed 14rem column, then the extra-time controls directly after it, left aligned (not pushed to the right edge), then one muted line from the plan text that mentions time (else its first description), with a left rule. Learning plans only, never a health alert; a dropped student is absent.
- **Extra time, three states:** **Confirmed** (the total and the extra minutes, the percentage, **Change**); **Suggested** ("Notes mention 25%", **Use 25%**, **Other**); **None found** ("No time in the notes", **Set extra time**). **Other**, **Set extra time** and **Change** open a `NumberStepper` (5% steps, `suffix="%"`) with **Save**. The confirmed percentage is stored per student (`student_extra_time`), not per course, so it shows in every course the student is in. Plan text is read live, only for students not yet confirmed, one after another (a confirmed student shows **Show plan** on request). A refused read (`SECURITY_VIOLATION`) or an ended session (`SESSION_EXPIRED`) stops the reads, on request too, and the list shows one warning, "Could not read the plans:" with the Support Summary's own reason; the unread cards offer **Set extra time**.
- **`NumberStepper`** (`step`, `suffix`) now passes `step` to the input so the arrow keys move by it, and shows a suffix after the number.

## Roster tab: Mastery (#160, 25 Oct 2026)

Prism's level is the correct one; Schoology's is what students and report cards see. A difference is a signal to override Schoology, so the two sit side by side.

- **Category names** read "CK - Content Knowledge": a short label and the title without the course prefix (#192; the number meant nothing to a teacher). The label is the initial of each main word ("Creating, Responding, Connecting" is CRC); within a course, labels that collide take one more letter until they differ (`client/src/lib/categoryAbbr.js`). The line chip (`.mastery-cat`, as wide as the course's longest label through `--catw`) shows the label, with the full name in the instant popover. A segmented control (`.mastery-cats`) chooses **All reporting categories** or one category.
- **All reporting categories** (`.mastery-card`): one card per student, a **Class average** card first (`.mastery-card--class`, `--bg-subtle`). Left, a small photo and the name with the grade and student number; in the middle one line per category (`.mastery-line`): a category chip (hover: its full name), the topic chips (hover: code, name, level, percentage), a divider, then Prism's level and Schoology's; to the right the grades. The topic chips sit in a track as wide as the longest category (`--maxt`), so the category levels line up in one column down the page. A header row names Topic averages, Prism, Schoology (with a `.help-dot`) and Translated grade; on a narrow roster it is replaced by one line with the help dot (`.mastery-phone-help`).
- **One reporting category** (`.mastery-row`): one short row per student under a **sticky** header (code in bold, name under it, over its topic column, then Prism and Schoology). Tap a topic heading or Prism to sort, highest first, again for lowest first, a third time to turn it off; a line above states the sort with **Clear sort**. Class average first. The page never scrolls sideways.
- **Values:** a topic chip is the mean of the student's scores on that topic ("-" outlined when not assessed); Prism's category level is the mean of every topic score in the category (all the points together, not a mean of topic means, the value the old roster called "Computed"); Schoology's is its category rollup (`override_value` else `grade_scaled_rounded`, asterisk when an override). Aligned categories with no scores yet show "-" levels and no grade (Graham confirmed 25 Oct 2026: no grade without evidence from every category). Hovering or focusing a "-" grade, the class average's too, names what is missing in a calm popover: "No grade yet: Producing has no evidence. A grade needs evidence in every reporting category." Nothing on the card itself marks it. The grade is the **Translated grade**: `computeLetterGrade` (HKIS's chart, see "Grade scale") on Prism's levels, with the grade scale "?" beside its heading (#193; on a narrow roster, in the help line). The Schoology grade column is gone (Graham, 25 Oct 2026: the level chips already show a mismatch); see "Translated grade and the mismatch warning".
- **Schoology chip styles** (`.sgc`): **agreeing**, faint: a dashed outline and muted text. **Differing**, filled in its level's colour with an **amber ring** (`.sgc.off`, `--warning`), so it stands out down a column. **No "!" badge** (Graham, 25 Oct 2026: overkill, and it moved the text). A missing Schoology level beside a Prism level counts as differing. The grade's Schoology chip follows the same two styles. The hover text states both levels.
- **The override:** tapping a category's Schoology chip opens `OverridePopup` (the student page's component and write path: it writes the override, then stores Schoology's reply) with Prism's level offered first ("Override Schoology to D"). In a set of linked sections (#178) the chip is disabled with the reason ("Prism does not write to Schoology for linked sections. Make this change in Schoology."). With Private details off no chip, level or grade is in the page.

## Hover text is an instant popover (25 Oct 2026)

- **Rule (Graham, every UI build from now on):** text a user needs on mouseover opens immediately on hover, focus or tap through `useHelpPop` / `.help-pop`, never a native `title` tooltip (too slow). The element keeps an `aria-label` with the same text for screen readers and agents.
- **Meaningful short labels:** a code or abbreviation stands for something a teacher recognizes (reporting categories as P, CRC, not their numbers), and its popover gives the full name.
- **Wrapping:** a long help text wraps in a rectangular popover with a sensible max width; it never runs off the screen on one line (#192). `.help-pop` resets the text style it would inherit (`white-space: normal`, weight, case), since it sits inside headings and chips; a short list goes in `.help-pop__list`.
- **`Tip`** (`client/src/components/HelpDot.jsx`, #192) puts the popover on any element: `text` is the aria-label and popover, `as` picks the element (`button`, `a`, `Link`), and `named={false}` keeps a button's visible word as its name. Every hover text on the Roster tab uses it, including the shared chips it draws (group pills, flag pill, email link, extension tag, the ≈ on the urgency ring).
- **The sweep is done (#199, 27 Oct 2026):** no native `title` tooltip is left in `client/src`; the 89 that remained (gradebook cells, the grade card, triage panels, quiz tabs, the assessment and student pages, dashboard cards, Class Tools filters) became instant popovers. The guard test `client/src/noTitleTooltips.test.js` parses every `.jsx` file and fails on a `title=` on a DOM element, on `Link`, `NavLink` or `Tip` (which pass it on to one), and on an SVG `<title>`; `<iframe title>` is allowed (its accessible name, never shown as a tooltip). Patterns it settled:
  - **Table cells:** `Tip as="td"` (or `"th"`) holds its popover inside the cell, since a `<span>` beside a `<td>` is invalid in a `<tr>`. A cell to click is named by its action ("Set Topic to Developing"); a descriptor cell keeps its descriptor as the `aria-description`.
  - **One popover per gradebook cell:** the cell's old native title (status badges' names, resubmission and mismatch signals, the timeline) joined its instant comment overlay (#36) as lines above the comment, and the cell's `aria-description`. The corner clock (`LateClock passive`), the status letters and the thread bubble have no popover of their own there, so a cell never opens two.
  - **Truncated names and titles** (triage rows, the course line, the question stem, email menu labels): `Tip clipped named={false}` pops only while the text is cut off by its ellipsis; when it fits there is nothing new to say.
  - **A button whose click opens something** (the comment and files chips, the email menu's @): `hoverOnly(handlers)` shows the popover on hover and focus only and hides it while the thread, list or menu is open (FlagsMenu's pill pattern). The quiz group chip's list opens on hover or focus and a click keeps it open.
  - **Disabled buttons** keep `Tip as="button"` with the handlers on the button itself (FlagsMenu's pattern): current browsers send hover to a disabled button but not focus. The grade card's Discard button pops only while disabled ("nothing to discard"); enabled, its label already says it.
  - **An optional hint:** `Tip` with no `text` and no `pop` is the plain element, so a badge whose note is empty draws no empty popover.

## Category short labels across Prism (#196, 25 Oct 2026)

- **Everywhere a category is tight:** the short label of the roster (P, CRC, CK, CTP) replaces a category number or a long title "HS Art: Creating, Responding, Connecting" in a narrow space. The full name, without the course prefix, is the instant popover.
- **Where:** the student page's mastery table (the category header over its topic columns); the line under each topic's title in the grade card's rubric (the assessment page, the gradebook pop-up and the student page), which reads "CTP 2.3" (the label and the topic number without its course prefix); the gradebook's rubric strip, whose popover lists "CTP 2.3 Abstraction: EX" for each topic (it was a native `title`).
- **One shared piece:** `CategoryTag` and `TopicSource` (`client/src/components/CategoryTag.jsx`, class `.category-tag`, bold, the color of the text around it), with `categoryLabels(titles)` and `topicNumber` in `client/src/lib/categoryAbbr.js`. A view labels the categories it holds, so its labels match the roster's unless two of the course's other categories collide.
- **PrisMCP keeps full names:** its answers already name categories in full (never by number), which an agent reads better than an abbreviation.

## Display covers the comment only (#184, 25 Oct 2026)

- **Finding:** Schoology's Display to student shows or hides the comment; the grade shows either way. A student's view (Schoology's View as tool) showed the score on a task whose records hold no comment and `comment_status` null.
- **Grade card:** with an empty comment the card shows a dashed **No comment** label where the Display switch was. Schoology keeps no Display for an empty comment (#183), so a switch there had no effect. Typing a comment brings the switch back, already on for a new record (the auto-flip), as Schoology's own default for a new comment.
- **Class switch:** renamed **Comment visibility for all students**. It counts only cards with a comment, and reads **No comments** (disabled) when there are none.
- **Hover text:** both switches use the instant popover (`useHelpPop`), not a `title`: "Show this comment to the student. This switch does not hide the grade." and "Show or hide every comment. This switch does not hide grades."
- **Triage label (25 Oct 2026, Graham's choice):** on a published task the reason reads **Comment hidden** (the student sees the grade); on an unpublished task it reads **Feedback hidden (task not published)**, in the triage panel, the filter pill and the card chip. The reason id stays `feedback_hidden` (and `feedbackHidden` in `get_triage`), so the API and PrisMCP are unchanged.

## Grade scale (#193, 25 Oct 2026)

- **One source for letter grades:** HKIS's "HS Proficiency to Letter Grade Translation Scale" (Translation_Scale_HKIS_FINAL.pdf, from Graham, 25 Oct 2026), transcribed in `client/src/lib/hkisLetterGrade.js` with a test for every cell. `computeLetterGrade` is a lookup in it; any IE is F. The old average rule and the old table disagreed with each other on 19 of 58 combinations and with the chart on more (2 categories, ED + EM: chart C, both old sources B).
- **Gap in the chart:** 1 ED, 1 EX, 2 D, 1 EM with 5 categories is missing. Every other 5-category combination with one EM is a C, so Prism uses C and marks it with an asterisk and a footnote.
- **Outside 2 to 5 categories:** no letter grade. The grade shows "-" and its popover states "No letter grade: HKIS's letter grade chart covers 2 to 5 reporting categories, and this course has N."
- **The "?" (`GradeScaleHelp`, `client/src/components/GradeScale.jsx`):** beside the roster's Grade heading, in the narrow roster's help line, and beside the student page's letter grade. It replaces the "Scale" links and the "Letter Grade Scale" modal. It shows only the course's column; its aria-label states the whole column in words.
- **Level strips (Graham's choice of three mocks):** each combination is one chip per category, best first, in the level colors (`.level-strip`), so it matches the roster's level cells and still reads without color.
- **Wide popover:** `HelpDot wide` / `useHelpPop({ wide: true })` gives `.help-pop--wide` (340px) for a small table. Any popover too tall for the space below its trigger now opens above it.
- **Settings, Grade scale:** the full chart (2 to 5 categories) in the same chips, then each level's score band from the proficiency scale in `config.yaml` (no fixed numbers). The bands are for an administrator checking Prism against Schoology, so they left the teacher's popover.

## Triage panel renamed Overdue work (25 Oct 2026)

- **Graham's request:** the Triage panel listing summative work still owed (and work handed in at the referral limit) is now titled **Overdue work** (was Late work). Earlier entries in this log use the new name. Internal names stay (`LateWorkPanel`, `#triage-late`, `lateWork` in `get_triage`), so links and PrisMCP are unchanged. Settings keeps "Refer late work at", which names the rule, not the panel.

## Translated grade and the mismatch warning (#193 follow-up, 25 Oct 2026)

- **One grade column (Graham's choice):** **Translated grade**, from Prism's levels. The second column, the grade Schoology's levels give, is removed; its popover explained little, and the level chips already show each mismatch.
- **Mismatch warning:** when Schoology's levels (the ones students see) translate to another grade or to none, an amber "!" (`.mastery-grade__warn`, the amber of a differing Schoology chip) sits beside the grade. Popover: "Schoology's levels differ from Prism's. Students see Schoology's levels, so their grade translates to B-, not B+. To correct it, override Schoology's level: click a highlighted Schoology level." When Schoology holds no level, it names the categories; on a linked section the last sentence is the linked-section reason. The class row never shows it.
- **Alignment:** the letter alone is centered in its column (a `1fr auto 1fr` grid), and a + or - sits outside it to the right (`.mastery-grade__mod`), so A, A- and B+ line up down the column (Graham, 25 Oct 2026). The "!" takes the right-hand track, clear of the modifier. "Translated grade" stays on one line, centered over the column.
- **Column overflow fixed:** a card's category lines no longer shrink below their chips in the wide layout. A shrunk line overflowed into the grade column and left the header about 60px out of line with the cards; the narrow layouts (760px and below) still let it shrink.

## Parent and child tabs (#194, 26 Oct 2026)

- **The problem (Graham, 25 Oct 2026):** the Roster tab's modes looked the same as the course tabs, so it was not clear that they belonged to Roster.
- **Graham's choice of three mocks: attached panel** (mock page https://claude.ai/artifact/46PmMhTCDkVCE7JLaVkf9d; the other two were an underline row and a segmented control). The active parent tab joins a pale purple panel (`.tab-panel`, `--accent-light` with an `--accent` border) that holds the tab's child row and its content. The tab squares its bottom corners and overlaps the panel's top edge by 7px; `.tab-panel--first` squares the panel's top-left corner while the first tab is active.
- **Classes (`client/src/app.css`):** the parent row is `.tab-row.tab-row--joined` of `.tab-btn`; the child row is `.subtab-row` of `.subtab-btn` (white raised chip when active, purple text otherwise). Both rows are `role="tablist"` with `role="tab"` and `aria-selected`.
- **Where:** the course page (Roster, Gradebook, Assessments, Analytics; the panel is the main column, the triage rail stays outside it) with Roster's four modes as the child row; a linked quiz's assessment page (Grading, Questions, Free response) with By question and By student as Free response's child row.
- **Unchanged on purpose:** filters stay round `.filter-btn` pills, so a page reads as tab, child tab, then filters. A view toggle that redraws the same content (Descriptors and Compact on the assessment page) stays a pill group. A tab row with no child row anywhere has no panel: Dashboard's Current and Archived, and the Manage rubrics pop-up (whose Attach, Map criteria and Row order now use `.tab-btn` instead of filter pills).
- **Header layout:** the course header has no bottom margin, so the tab meets the panel. The gradebook's type filter and the Triage button share the tab line, right-aligned; `flex-wrap: wrap-reverse` puts them on a line above when there is no room, so the tab row always stays next to the panel. A quiz's sticky header drops its bottom border and margin while the quiz tabs show.
- **Phone:** a joined tab row never wraps (a wrapped row would hang the active tab over the second line). At 390px the four course tabs fit at 0.8rem with smaller side padding; on a narrower screen they shrink with an ellipsis. The rule is in the PHONE LAYOUT block.
- **Private details:** the issue's plan to put the switch on the Roster child row was dropped; #197 moved it to the sidebar for the whole app.

## Attempts tab (#200, 26 Oct 2026)

- **Graham's design (26 Oct 2026):** a linked quiz's page has three tabs, **Grading** (the result task), **Questions** (class statistics) and **Attempts** (the Schoology test itself, for any mix of MCQs and FRQs, so a validation test works too). Attempts replaces the Free response tab; `?tab=frq` opens it. Design: `docs/superpowers/specs/2026-10-26-linked-quiz-attempts-design.md`.
- **Child row:** By student (the default) and By question, as Schoology has, in the #194 `.subtab-row` inside the tab panel.
- **By student:** Previous, a student picker and Next walk the class. Each attempt (`AttemptByStudent.jsx`) has a header (the name, the member test as a badge when the group has more than one, the attempt link, the time taken), the test's own grade card (`StudentRubricCard` for the member test: score, overall comment with the template suggestion, the quiz line and Update numbers), the percent by tag when the quiz has tags, then every question: an MCQ row (`McqAnswer.jsx`) or the FRQ marking card. Every attempt stays mounted (hidden) so Publish test comments covers the class.
- **MCQ row:** the stem, the options with the chosen one and the key marked (the key green, a wrong choice red), Correct / Incorrect / No answer, the points, and the class's percent correct with the Questions tab's band. The aria-label states the row in words ("Q3: chose B, incorrect. Answer C. Class 55% correct.").
- **By question:** one picker over every question, the stem once; an MCQ adds the class's option counts ("A 3, B 3, C 11 (answer), D 3") and a compact row per student; an FRQ shows one marking card per student.
- **One bar:** FRQ only (By student, when the quiz has both kinds), the FRQ filters (when it has FRQs), Publish all to Schoology for FRQ marks (or "n waiting for the agent"), and **Publish test comments (n)**, named so it cannot be confused with the FRQ button. Test comments go to the test each student took, never the result task; Grading's own Send all covers only the result task.
- **Grading:** the cards keep the quiz line and the attempt link, without Numbers changed or Update numbers (the template comment is on the test now). A quiz with no result task linked shows "No result task is linked to this quiz." and a Link a result task button that opens Quiz setup.
- **Marking card in an attempt:** `FrqCard showStudent={false}` leaves out the name and attempt link the attempt's header already shows.

## Gender and age on the student page only (27 Oct 2026)

- **Graham's decision (27 Oct 2026):** the gender tag, and the age #191 proposed, are on the student page only, and the Roster tab's cards show neither. The roster keeps its **Gender** filter row and the Gender sort (Private details only, as before).
- **Where:** the student page header, a small muted tag group right after the name (`.student-tags` of `.student-tag`, `components/StudentTags.jsx`), before the grade badge. The codes and labels are unchanged (`lib/genderTag.js`: F, M, NB quoting PowerSchool's value, ?). Age (#191) is meant to be the group's first tag.
- **Private:** rendered only with Private details on, as it was on the roster, since the student page can be projected in a parent conference.
- **Hover text:** the instant `.help-pop` through `useHelpPop`, with the full label as the `aria-label`; never a native `title`.
- **The card:** the name line holds the name alone, so a tap anywhere on the card except a button or link opens the student page.

## A failed read is not "no data" (#189, 27 Oct 2026)

- **Rule:** when a read fails, the view says so in an `.alert.alert-warning` ("Could not read triage for this course. Reload the page."), never the empty or loading message ("Reading triage...", "No mastery data yet").
- **A failed re-read** keeps what was already shown, under a warning that it may be out of date (the Mastery view after an override).
- **A write in progress** disables its own buttons (Refer, Waive, Undo), so a double click writes once.

## Override refusals (#188, 27 Oct 2026)

- **Where Prism does not write** (an archived course, a set of linked sections), the Schoology level stays visible but does not open the override: the Roster's Mastery chip is disabled with the reason as its popover, and the student page's Schoology cell's popover states it.
- **A refused override** shows its reason inside the pop-up as an `.alert.alert-warning`, and the pop-up stays open. When Schoology had changed, the levels behind it are read again first, so the teacher decides on what Schoology holds now.

## Test day clock times (#187, 27 Oct 2026)

- **When:** a test is chosen, the class meets on its due date, and Prism has that lesson's times from PowerSchool's bell schedule. Otherwise Test day stays in minutes only.
- **The bar** gains one muted line under the picker (`.test-day__clock`): "The lesson on 29/10/2026 runs 8:35 AM to 9:45 AM. A 50-minute test that starts with the lesson ends at 9:25 AM." It follows the length stepper.
- **Each confirmed card** adds a muted "ends 9:38 AM" under the minutes. A student who runs past the lesson's end reads "ends 9:50 AM, 5 minutes after the lesson ends" in amber, bold (`.test-day-card__over`), so the teacher can plan where that student finishes.
- **12-hour times** with AM/PM, as the sync status shows them. The schedule is not private: the bar line shows with Private details off; the student lines only with it on, as the cards do.

## Birthdays and age (#191, 28 Oct 2026)

- **Public, with Private details off:** only the fact that today is a student's birthday: a small cake after the name on the roster card and the student page header (`BirthdayMark`, `.birthday-mark` in `--accent`, popover and aria-label "Birthday today"), and on the dashboard one line per student, "It's Ana's birthday today." Never the age or the date. Nothing is drawn when nobody has a birthday.
- **Private, with it on:** the age as the first tag after the name on the student page ("16", popover "Age 16, born 15/06/2010"); the dashboard's **Birthdays** card listing every current student whose birthday is from 3 days back to 7 days ahead, "turns 17 on Sat 31/10" or "turned 16 on Tue 27/10", with a cake on the ones marked today and their courses; the home room and guardianship lines on the student page.
- **Weekend or holiday:** the mark shows on the school day before (Graham, 28 Oct 2026), so a Saturday birthday is marked on Friday and one in a holiday on the last school day before it (that student is on the list that day too).
- **Where on the card:** the cake sits on the name line after the name, so the card gains no height (Graham picked it over a meta-line chip, 28 Oct 2026).

## Student page header, alerts and recent tasks (#185, 28 Oct 2026)

The best parts of the roster drawer Graham rejected in #160, on the student page (mock: https://claude.ai/artifact/Lt9Kcgv1ruhkhT2ny59fiP).
- **One line under the name, as on the roster card:** grade (or "Class of YYYY" for a past student; popover "Graduating YYYY"), the student number (the email's local part) and the roster's **Email** copy button (`CopyEmail`, exported from `RosterCard.jsx`), separated by small CSS dots (`.student-meta`, the roster meta line's pattern). It replaced the blue grade badge, the "ID:" text and the `mailto:` line. Public, as on the roster.
- **Alerts in place** with Private details on; family alerts behind **Show family alerts (N)** (see "PowerSchool alerts").
- **Recent tasks** (`components/RecentTasks.jsx`, `lib/recentTasks.js`): a card under the header with the last 6 tasks due by today in the student's current courses, newest due first. Each row: a mark, the task (a link to the assessment page at this student) over "course, due DD/MM", and the status at the right in the submission timeline's words ("Submitted 26/10 21:14", "... (1 school day late)", "Not submitted (2 school days overdue)", "..., over the limit"). A Schoology flag is its `FlagSymbol` and its name (Missing, Exempt, Late ...). With no submission tracked online the row says only "Graded" or "Not graded yet", never that work is missing. Tones: on time green, late or overdue amber, past the limit or Missing red, the rest muted. Shown with Private details off, as the grade cards are. On a phone the status drops under the task.
- **Unread comments filter** beside the Courses heading: a `.filter-btn` pill with the number of tasks with an unread student comment (from this student's comment summaries), shown while one has. On, each course shows only those tasks and a course with none is left out; "No task has an unread comment now." when they have all been read. Cleared when the page moves to another student.
- **Absences** wait for #39 (attendance).

## Graded unpublished tasks on the student page (#206, 28 Oct 2026)

- **Graham's choice:** a task unpublished on Schoology appears on the student page while the student holds a grade on it (score, comment, flag, topic or row level), in every course, current or archived. An ungraded unpublished task stays hidden, as before.
- **Mark:** a grey `badge badge-gray` "Unpublished on Schoology" after the task title in the card heading, the gradebook popover's wording.
- **Why:** a past section's tasks can be unpublished after grading (78 of 82 in AP CSP 2025-26); hiding them hid a student's record. The course tabs keep their Unpublished filter.

## Counselors (#190, 28 Oct 2026)

- **A section headed "Counselors"** on the student page, above the family contacts: each counselor in the contact card style (`.counselors__item`), the primary first.
- **"Primary", not "Assigned"** (Graham, 28 Oct 2026): a student belongs to both counselors of their community; PowerSchool's primary one carries a blue `Primary` badge.
- **No community name:** PowerSchool does not name it, and Prism does not guess one.
- **Public:** shown with Private details off (counselors are staff). Each email is a mailto link with a copy button; **Copy emails** copies both as "Name <email>"; a counselor Prism could not match shows "Email not found in Schoology".

## Profile pages (#203, 28 Oct 2026)

- **Who it is for:** anyone People search finds who is not a Prism student (a Prism student opens their student page). A result's name links to `/people/:uid`.
- **Header card:** photo (`PersonAvatar`), name, a grey kind badge (Student, Staff, Parent; none when Schoology does not show which), the school email, "Read from Schoology DD/MM/YYYY" with **Read again** and **Open in Schoology**, and **Delete profile** (asks once inline).
- **Public:** a staff member's Position, Subjects taught and Phone; a student's Current courses and Groups; a parent's Children (each to their student page or profile).
- **Private (Private details):** a student's Parents and the teacher's Notes, behind one `PrivateHidden` box.
- **An old read is dated, never passed off as today's** (Graham, 28 Oct 2026): when Schoology cannot answer a re-read, an amber alert states why and the date the shown data was read.

## Attendance tab (#39, 29 Oct 2026)

- **Where:** a tab on a current course's page, second after Roster (Graham, 29 Oct 2026: attendance matters, so not last), private (`PrivateHidden` "Attendance is private."). The triage rail is hidden by default there, as on the Gradebook.
- **Lesson line:** the lesson's date in quick words, "Today (Thu 29/10)" or "Yesterday (Wed 28/10)", else just "Tue 27/10" (Graham, 29 Oct 2026), its time, a calendar icon button, and the taken badge.
- **Lesson calendar** (Graham, 29 Oct 2026, his pick over a two-week strip): hidden until the calendar icon is pressed (not shown all the time), closed again by picking a lesson. A small Monday-to-Friday month grid (`.att-cal`) with ‹ › for other months and a key (Taken, Not taken, Today). The class's lessons up to today are buttons with a dot, green when PowerSchool holds attendance, amber when not yet, so a missed lesson stands out; later lessons show with a hollow dot and no button; other days are greyed; today has an accent ring that stays visible when it is the open lesson, which is filled.
- **Opening lesson:** today's. On a day the class does not meet, the last lesson, under a blue line "This class has no lesson today (Wed 28/10). Showing the last lesson, Tue 27/10. Next lesson: Thu 29/10." (Graham chose this over a blank page.)
- **Present is a choice** (Graham, 29 Oct 2026, an improvement on Schoology's blank cell). Before attendance is taken a blank mark shows as not marked (the row tinted), not as Present.
- **One short line per student** (Graham, 29 Oct 2026: buttons spread along the line took too much room): the name on the left, and in a right-hand column one joined pill strip `.att-strip` of small segments **Other ▾** | **Tardy** (amber) | **Absent** (red) | **Present** (green), Present on the far right (Graham, 29 Oct 2026). Graham chose this over a letters-only strip and a native select.
- **Other ▾** opens a menu styled as the grade card's Flags control (`.att-menu`, "OTHER CODES" heading, each code in bold with its name, the chosen one ticked; arrow keys and Escape). The chosen code then shows on the segment ("I: Illness ▾", accent).
- **The fill button names its count** (Graham, 29 Oct 2026: "Mark all present" read as overriding marks already chosen): "Mark all 9 present" while nobody is marked, "Mark the remaining 6 present" once some are, gone when none is left. It fills only rows not marked yet; chosen marks and office marks stay. A live count line ("Present 8, Tardy 1, Absent 0, Not marked 2") sits beside it.
- **Office marks** (entered by the attendance office, PowerSchool's `readOnly`) show in the same right-hand column as a grey "Office: Illness (I)" badge with the office's comment, and no controls.
- **The counts and Save sit under the list** (Graham, 29 Oct 2026: teachers read the whole list top to bottom before saving); the fill button stays above it. **Save to PowerSchool** is enabled when every row is marked and there is a change (or attendance is not taken yet). After it: "Saved to PowerSchool at HH:MM:SS. Every mark read back as sent." A refused save says why and redraws the lesson as PowerSchool now holds it.
- **Rows wrap** (`flex-wrap`), so the same layout works on a phone with no rule in PHONE LAYOUT.
