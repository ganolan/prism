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
     not `Display all` / `Hide all` (command). The switch position says on/off.
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
  and roster pages, just the inline styles a phone needs to change moved into
  classes (a `QUICK-LOOKUP PAGES` section of `app.css`), with the old inline
  values verbatim, so desktop is pixel-identical (diffed against `main` at
  1440, 1024 and 800px, including the note form open and in edit). The phone
  rules are in the `PHONE LAYOUT` block as before.
- **Secondary columns fold under the name.** A phone hides a table's secondary
  columns (`.col-desktop`: Email and Grade on Search and the roster, School in
  the Directory) and shows the same facts as one muted line under the name
  (`PersonSub`: `.person-sub.phone-only`, the parts joined by " · "). Search and
  the Directory then fit, so they stay real full-width tables
  (`table.fits-phone`) instead of sideways-scrolling boxes. The roster's
  mastery columns still scroll inside their box: they are the genuinely wide
  part, and #160 will redesign the roster.
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
labels are day numbers ("Late work is allowed through day [8]"). Display only — the server keeps its
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

**Rail.** The three triage panels stack in a right-hand **rail** (`<aside class="triage-rail"
aria-label="Triage">`, 380px) beside the page's main column (`.triage-layout` →
`.triage-layout__main` + rail): Make-up tests, Late work, Feedback owed. On the Dashboard (Current
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
behaviour, at every rail width, not just on phones. Late work stacks **Refer** above **Extend** on
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
· refer after day 8"); the Referred / extended history link stays at the bottom of Late work. Reuse
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

- **"@ ▾" in a panel header** (Make-up tests, Late work, Resubmissions) copies the addresses of students who still owe something: tiers Red / Red + amber / Everyone still owing, then By assessment. Format `a@x; b@x` for Outlook To or Bcc. Students who already acted (submitted late, resubmission arrived) are left out of the bulk copy. "@" was chosen over the word "Email" because it reads as *addresses* and keeps the header on one line on a phone.
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

`HelpDot` (`client/src/components/HelpDot.jsx`) is now the component form of `.help-dot` + `.help-pop`.

**Lateness is a distance, never "day N" (2026-10-07).** On the timeline, "day 5" was read as timetable cycle day 5 (the school's 8-day cycle numbers its days 1-8). Lateness now reads "4 school days late" / "5 school days overdue" (the clock day minus one), and the "?" says "Counted in school days after the due date (or the extended date). Work 8 or more school days late is referred." On a phone each timeline fact sits on its own row with no dots; elsewhere the dot trails the part before it, so a wrapped line never starts with one.

## Waive, and deadlines that count from today (October 2026)

- **Waive, not Ignore or Excuse.** A late submission past the referral limit can be referred or *waived*. "Ignore" reads as neglect in a record the academic office may see; "Excuse" clashes with Schoology's *Exempt* flag (not required to do the task). The button says **Waive**, the confirm button **Waive referral**, the history **Referral waived · 8 school days late** (grey, not red), with the teacher's optional reason. Extend is not offered on work that is already in.
- **A deadline you set is always in the future.** Extending counts from the later of the start date and today, so the hint never says "already passed" and "Next lesson" is a small number. The extension tag and history show only the resulting date ("ext → 19/10/2026", "Extended to 19/10/2026"): a count from a moving start would mislead.
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

- **Two reason rows, "any of":** **Needs action** (your move now: To grade, Partly graded, Draft not published, Feedback hidden, Resubmitted, Referral to decide, Resubmission overdue, Make-up test) and **Watch** (may need a word with the student: Not started, due soon; In progress, past due; Late, before the limit; Resubmission pending). Every selected reason in both rows combines as "any of". A pill shows only while some student has that reason (or it is selected); an empty row reads "Nothing needs action" / "Nothing to watch". The page opens with nothing selected: all students.
- **Refine (collapsed):** the old descriptive pills, still OR within a group and AND across groups, narrowing whatever the reasons selected. "Not visible" now counts only feedback that exists. Refine opens by itself while one of its pills is active.
- **Reason chips on each card:** a row under the header, aligned past the avatar like the timeline, with the same names as the pills plus the detail ("Referral to decide, 11 school days late", "Resubmission due 20/10"). Late clocks take triage's green / amber / red.
- **The list holds still while you work:** who matches is worked out when the filter changes, not on every save, so a card stays in view after its reason is resolved. "N shown students no longer match the filter. Update the list" refreshes it. Filtered-out cards stay mounted and are only hidden, so an unsaved draft survives a filter change. The class-wide bar (Publish all, Discard all, Show all, Mark all, Accept all) acts on the shown cards.
- **One source per reason:** the calendar reasons come from triage's own rows (`server/services/cardAttention.js`), so a card never disagrees with the dashboard; the grading reasons are worked out on the page (`client/src/lib/assessmentFilters.js`) and follow each save at once.

## Triage: Unfinished grading and filtered links (October 2026)

- **Unfinished grading panel** (named "Loose ends" for its first two days; renamed 17/10/2026 to say what it holds): in the triage rail (Dashboard and course page), one row per task with unfinished work that runs on no clock: drafts not published (a live Prism draft; one Schoology changed under is left out, the same check the card makes), feedback hidden (a teacher comment the student cannot see), unread student comments. No ring and no action column, because nothing here is late: title, then "2 drafts not published, 1 with feedback hidden, oldest draft 09/10/2026", then the course line. Tasks with a draft come first, oldest first. Hidden when empty, like Resubmissions. No Stats strip tile: the tiles are for overdue work.
- **Links open the page already filtered (`?filter=`):** an Unfinished grading title selects that row's reasons; a Feedback owed title selects the whole Needs action row (`?filter=action`; a group name stands for its row); a Resubmissions name focuses the student and selects Resubmitted (arrived) or Resubmission pending + overdue (waiting). Late work and Make-up names still only focus the student.
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

## Shared feedback view: gradebook modal and student page (October 2026, #135)

One read-only component, `AssignmentFeedback` (`client/src/components/AssignmentFeedback.jsx`, `.assignment-feedback*` in `app.css`), shows one student's feedback on one assignment. The gradebook submission modal and every assignment on the student page render it, so the two can no longer drift apart.

- **Order:** badges with the work links, the submission timeline, the rubric, the comment. Sections stack with one gap (`flex` column), so a missing section leaves no blank space.
- **Badges row is a slot:** `SubmissionBadges` first, then whatever outbound links the caller passes in `links`: the OneDrive **Open** link (#120), the submitted files chip (#107, #162), **Attempt**, the submission comments chip (each when its feature is on). A new link component drops into the slot without touching the shared markup. A row whose links all render nothing collapses (`:empty`).
- **Full descriptors when a rubric is attached:** `RubricDescriptorGrid`, read-only (no `onSelect`: no pointer, no "Set ... to ..." tooltip), with the awarded cell filled and outlined in its level colour, exactly as a published level on the /assessment/ card. With no rubric attached, or one that maps none of the topics, the compact grid as before.
- **Points-only tasks** ("50 / 100", and scale levels such as "Completed") put **Score:** in the rubric's place. In the gradebook these cells now open the same modal (`button.cell-open`, which looks like the plain score), for the comment and timeline. The modal's type chip follows the task (S or F) instead of always S.
- **Modal width:** 560px, widened to 1100px only while descriptors show; the overlay padding caps it to the viewport. On a phone it is a full-width bottom sheet, and a descriptor grid keeps a 640px minimum and scrolls sideways inside its own box rather than squeezing each descriptor to a word per line.
- **Comment:** always the boxed `var(--bg-subtle)` block with a bold "Comment:" (the student page used to show it as muted italics); line breaks in the comment are kept.
- **Rubric hidden by Exempt in the shared view (revised 22 Oct 2026, #40):** the card locks both final flags (Exempt and Missing), but the shared view (student page, gradebook pop-up) replaces the rubric with the dashed "rubric hidden" note for Exempt only; Missing shows IE instead (see "Missing shows IE" below). A marker (Late, Incomplete, Absent) keeps the rubric, with its inline symbol and "Grading this work clears Late." above it (`.assignment-feedback__marker`), because the teacher grades straight through it. The gradebook cell of a marker still shows the symbol in the grade's place (never the mini strip) and its pop-up shows the rubric. The student page once hid the rubric for Late alone, then not at all, then for every flag; the two surfaces still agree.
- **Student page fetches:** one batch request for every assignment's attached rubric (`GET /api/rubrics/assignments?ids=&student_uid=`), not one per assignment.
- **Feedback rows in the shared view (18/10/2026):** an unaligned score-scale task with a rubric attached shows the rubric's rows (first column "Criteria", the same grid as the /assessment/ card) with the student's published row levels as the awarded cells, then **Overall:** and the scale level chip, then the comment. Same in the gradebook modal (which widens for it) and on the student page. The rubric batch carries `mode` and, with `student_uid`, that one student's `rowLevels`.
- **The student page carries this student's links (Graham, 18/10/2026):** in parent-teacher interviews he projects only the student's own page (/assessment/ shows other students' feedback), so each assignment shows the OneDrive **Open** link and the submission comments chip in the badges row, as the modal does. Both load after the page renders and never block it, and both are fetched for this student only: `GET /api/students/:id/work-links?assignments=` returns only their link (files are still matched against the whole class, so a shared name matches nobody), and `GET /api/submission-comments/student/:id` returns only their summaries and queues a background read of their own threads, with one re-read later. OneDrive is asked three assignments at a time; each request lists them in one browser session (one sign-in instead of one per assignment), filling links in as answers arrive, and the page stops asking when there is no session or sign-in fails. A chip shows once the student handed in, the task is graded, or a read found comments: a chip on every untouched task was noise.

## PowerSchool alerts (October 2026, #117)

The alerts PowerSchool shows beside a student's name (accommodation plans, learning support, health, family), as badges. Present only when the `powerschool_alerts` feature is on (`PsAlertBadges`, `.ps-alerts`). **Hidden by default everywhere**, because both pages may be on a projector (a roster in class, a student page in a parent conference). Revised 18/10/2026 at Graham's request.

- **Plain badges, coloured by kind:** learning support and accommodations `badge-blue`, health (EpiPen, allergies, health care plan) `badge-amber`, other (mobility, elevator, no photo) `badge-gray`, family (correspondence G1 / G2 / G1+G2, divorced/separated, staff child, siblings) `badge-pink`. No red: an alert is information for planning, not an error or a destructive action.
- **Short, neutral labels written by Prism,** not PowerSchool's own names (which carry typos such as "Accomodation"): "Accommodation plan", "Learning support 2", "ILP", "Divorced/separated", "Staff child". The full name is in the hover title. They say a plan exists, never what it contains.
- **Student page: hidden until clicked, never remembered** (`PsAlertReveal`). Before the click the only trace is a small `.ghost` button, **Show alerts (N)**: no labels, no colours, no categories, no read date. The click shows every alert (family ones included), muted "from PowerSchool, read DD/MM/YYYY" and **Hide alerts**. Each page load, and each other student, starts hidden again.
- **Roster: a toggle, off by default, remembered per browser.** A `.filter-btn` named **PowerSchool alerts** (the state is the button's active fill and `aria-pressed`, not its wording) sits in the roster toolbar beside "N dropped (show)" (`.roster-toolbar`). On, a compact group (`.ps-alerts-compact`, 0.62rem) follows each name. The choice is kept in `localStorage` (`prism:roster:show-ps-alerts`, read and written in try/catch; unavailable storage means off). Rosters show **learning, health and other only, never family alerts**: the API leaves them out of roster data and the client filters again (`forRoster`).
- **Hover:** each badge's title names the source and the read date ("EpiPen. From PowerSchool, read 17/10/2026").
- **Not elsewhere yet:** no other view shows alerts until Graham decides which should (a course roster redesign is a separate issue).
- **Guardian contacts behind the same reveal (#66, 21/10/2026).** With the feature on, each guardian on the student page carries PowerSchool's contact status, and the family facts stay behind **Show alerts**. The reveal state lives in `StudentPage` and is shared by the badges and the guardian cards (`PsAlertReveal` is controlled there through `shown` / `onShownChange`; uncontrolled for any other caller), cleared when the student changes.
  - **Deceased:** no card until the reveal; then the card with "Deceased (PowerSchool)" and the email as plain text. **Do not contact:** the name only until the reveal; then "Do not contact (PowerSchool)" and the email as plain text. A revealed card shows a phone as plain text, with no Edit.
  - **A flagged slot no guardian is matched to (the controller's ruling, 21/10/2026):** when PowerSchool flags Guardian N and Prism places no guardian uniquely in slot N, every guardian it could be takes that flag and is hidden the same way. A guardian placed uniquely in a slot keeps their own status. After the reveal the reason states why Prism could not identify them, then the flag: "Not matched to a PowerSchool guardian. Guardian N is flagged: Deceased (PowerSchool)" (the first part can also be "Not checked against PowerSchool yet" or "Matched to the same PowerSchool guardian as another parent"). The page shows the API's reason as sent.
  - **Not matched / not checked:** always visible, with a muted reason line ("Not matched to a PowerSchool guardian", "Not checked against PowerSchool yet") and the email as plain text. The extra phone stays editable, and no number on such a card is a `tel:` link. These say nothing about the family, so they need no reveal. With the feature on, a guardian sent without a status is shown as `not_checked`.
  - **No contact affordance on any guardian not cleared:** no `mailto:` link, no copy button (`.contact-email-plain`), so the address is never one click from an email.
  - **Primary contact:** a `badge-pink` label beside the name of a contactable guardian, always visible (Graham, 21/10/2026: the teacher needs it at once; it states who to email, not a family circumstance).
  - **Show alerts (N)** counts the PowerSchool alerts plus the do-not-contact and deceased guardians, so it appears for a student with a flagged guardian and no other alert. Revealed with no alerts, it shows only Hide alerts (no empty badge row, no alerts read date).
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
- **Confirm under the row** (the make-up tracking pattern): "Publish <b>title</b> on Schoology? Students see it at once." with **Publish** (`.primary`) / Cancel, or "Students stop seeing it at once." with **Unpublish** (`.primary.danger`). After the write, a green line "Published on Schoology (checked)." for 5 seconds; a refusal shows in the tab's `.alert.alert-warning`.
- **Live courses only**, like the make-up chip. The row shows the state Schoology read back after the write.

## Remote sign-in to Schoology (October 2026, #136)

- **One sign-in path:** Settings → Schoology connection → **Log in to Schoology** opens `RemoteSignIn` inside the card. Every other "Log in to Schoology" button (Sync dialog, sync progress, archived courses, course page) goes to `/settings#schoology-signin`, which opens it at once (`client/src/lib/signIn.js`). Helper text: "Opens the sign-in here, on this device: a phone works too."
- **The picture is the page:** the server's sign-in (400 x 720 page pixels, portrait so it suits a phone) shown full card width, at most 420 px; a tap maps to page pixels. One line of instructions above it, including "At "Stay signed in?" choose Yes".
- **Typing:** one field, hidden by default (`type="password"`) with a **Show** tick box, then **Type it** (`.primary`). Font size 1rem so a phone does not zoom. Key buttons **Enter**, **Backspace**, **Tab** (`.secondary`) and **Cancel** (`.ghost`) on one wrapping row.
- **End states:** "Signed in. Prism saved the session." (`.alert-success`, Close) or a warning (closed, left too long, could not open) with **Start again**.

## Student Support Summary inside "Show alerts" (October 2026, #163)

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
- **The label is the point:** `SyncStatus` puts "Synced 03:02 today" (`.sync-status__time`, 0.95rem, weight 600, a pill on `var(--accent-light)`) before the `.primary` button, right-aligned in the header. A day old, or "Not synced yet": the pill turns amber (`var(--badge-amber-bg)` / `var(--badge-amber-text)`). The time is the last full sync of that course or task (`course_synced_at`, `task_synced_at`), never a background read.
- **One small line under it** for the page's own background reads (#52, #108): "Checked for new work at 10:05 today.", "Checking Schoology for new work…", or "Could not check Schoology for new work." in `var(--badge-red-text)` with **Log in to Schoology** when the session lapsed. It replaces the course page's two muted freshness lines and the assessment page's mastery line.
- **Sync Course runs in the sync dialog** (the same progress view as Sync Courses), so it shows each phase and survives a dropped connection; the button reads "Syncing…" while the dialog is open.
- **Phone:** the label and button sit at the start of the line (PHONE LAYOUT block).

## Background sync: one "Synced" time and a chip (October 2026)

- **One time per page** (Graham, 20/10/2026: "Confidence comes from not having to second guess the data"): `SyncStatus` shows only "Synced 10:05 today", the last time *everything* in the page's scope synced (Schoology data, every submission read, comment threads, mastery). The "Checked for new work" line and the muted mastery lines are gone. Amber when a day old or never; never amber for an archived course (frozen data).
- **A manual Sync button wherever synced data shows (Graham, 20/10/2026: it gives back some control):** the dashboard's Current tab (Sync Courses; the Archived tab shows its Synced time with no button, `SyncStatus label={null}`, since archived data is frozen and the sidebar button is gone, #171), the course page (Sync Course), the assessment page (Sync Assignment) and the student page (Sync Courses: the student's current courses, or their archived ones for a past student, and shown even before any grades). Background sync never replaces the button. Pages with no synced scope of their own (Search, People, Feedback, Tools, Import, Settings) have no sync button.
- **The chip** beside it while the page's background sync is queued ("Waiting to sync…"), running ("Syncing…", with the small spinner), failed ("Sync failed", red outline) or held for a sign-in ("Log in to Schoology", amber fill). A rounded outline button (`.sync-status__chip`, 0.78rem, weight 600); clicking it opens the progress dialog on that run (or the sign-in). The Sync button is disabled only while the chip shows a running sync: a press while a page sync waits goes ahead of it in the queue. A run a Sync button starts is followed by the same chip after its dialog closes (`SyncDialog onRun`). A scope whose last try failed within 10 minutes shows "Sync failed" on that run instead of trying again at once. For a course scope, a failed task or quiz run does not count: only a failed course or full sync shows the chip (#170).
- **Where:** course page (Sync Course), assessment page (Sync Assignment), dashboard header on the Current tab (Sync Courses; the time is the oldest current course's), student page beside "Courses" (Sync Courses for that student's courses; the oldest of them).
- **The dialog** follows queued runs: "Waiting for the running sync to finish, then this one starts."; a held run shows "Waiting for a Schoology sign-in" with **Log in to Schoology**, and the dialog keeps following it, so a sign-in on another page or device lets it run on in the same dialog. On the assessment page the dialog does not reload the page itself: the page's own refresh decides, so an unsaved draft is never replaced.

## Freshness lines name the data, not the system (October 2026, #171)

- **Name the data, not the system behind it** (Graham, 20/10/2026): no freshness line or help text says PowerSchool or "Schoology's systems". The one exception is the help's last line, "Press Sync Courses only if you changed something in Schoology just now", which says where the teacher's own change was made. The progress dialog and provenance labels keep "PowerSchool".
- **A help "?" beside every Synced time** (dashboard, course, assessment and student pages; the Archived tab too): `SyncHelp` on the shared `HelpDot`, whose popover now takes children (an intro, two bold-labelled bullets, a last line). Bullet 1 is the page-open refresh (10 minutes); bullet 2 is "Blocks, calendar and alerts", refreshed every night when the night's refresh is on, otherwise when the teacher presses Sync Courses (on the dashboard) or says to press it on the dashboard (other pages). The "?" shows at once: until `GET /api/sync/status` answers (or if it fails), bullet 2 takes the night's refresh as off.
- **A past course's help says it is not refreshed** (final review, 20/10/2026): wherever the Synced time is an archived one (the dashboard's Archived tab, an archived course or assessment page, a past student's page), the "?" reads "Prism does not refresh past courses automatically." then "Open a course and press Sync Course to read it again." (dashboard), "Press Sync Course to read it again." (course page), "Press Sync Assignment to read it again." (assessment page) or "Press Sync Courses to read it again." (a past student's page): two lines, no bullets (`SyncHelp archived`).
- **The nightly line** (dashboard Current tab only, `.sync-status__nightly`, beneath the Synced time): "Blocks, calendar and alerts: 03:01 today". Amber (the `--badge-amber-*` tokens, as the Synced time) when the stamp is missing ("not read yet. Press Sync Courses to refresh them.") or over 26 hours old ("N days old", N whole days, at least 1, "1 day old" singular). The 26 hours give a night's run some slack; the line is amber whether or not the night's refresh is on, so a missed night always shows.

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

- **A flag is a symbol, never a chip (revised 21 Oct 2026).** Exempt, Late, Absent, Incomplete and Missing replace the grade in the gradebook cell (and the pop-up, student page and assessment card's score slot) with `FlagSymbol`: a round 18px disc with a 12px glyph and the flag's name under it in 8.5px bold capitals (`inline` size: 16px disc, 10px glyph, for text rows). Where it shows: the gradebook cell, its pop-up and the student page (the shared view), and the assessment card's status area (in place of the text status pill, with its name, 22 Oct 2026). Glyphs are inline SVG: Exempt a circle with a diagonal stroke, Late a clock, Absent a person beside a small circle with a diagonal stroke at its bottom left (as in Schoology), Incomplete a half-filled circle, Missing an exclamation mark. The first dashed `Exc` / `Inc` / `Miss` chips read too much like a level chip; a symbol cannot be mistaken for a grade. The popover reuses `.help-pop` (hover, focus or a tap; Escape closes) and holds the symbol beside the name, one guide line (`flagGuide`, e.g. "Left out of Sam's grade."), the reason line Prism wrote and, when Prism kept a copy of the grade, "Grade saved in Prism: Exhibiting (3.5). Clear the flag to restore it." In a gradebook cell the symbol is `passive` (hover only), because the cell is a `cell-open` button that owns click and focus and opens the same pop-up a graded cell does.
- **Flag colors follow Schoology, everywhere a flag shows:** Exempt green (`--flag-exempt`), Late red (`--flag-late`), Absent slate gray (`--flag-absent`), Incomplete amber (`--flag-incomplete`), Missing red (`--flag-missing`, the one outlined symbol: a white disc with a red ring), each with a pale `-bg` for badges and a white `--flag-glyph` for the solid discs. `EXCEPTION_TONE` in `gradeLabel.js` gives the flag badges (`SubmissionBadges`) the same tones (`slate` is new, class `badge-slate`), and the "Exempt, rubric locked" badge takes the flag's color too. Green is also the level EX and "Submitted"; the symbol and the words keep them apart.
- **Overdue is Prism's status; Missing is Schoology's flag (21 Oct 2026).** The red pill for past-due work with nothing submitted reads "Overdue" (kind `overdue`, gradebook letter **O**); "Missing" (its symbol) now means only Schoology's exception 3, so the two cannot be confused. The triage reason `referred_missing` keeps its wording, "Referred, not submitted".
- **`amber` status tone is `badge-amber`.** It was pink while nothing used the tone; Incomplete is the first user. (The card's status pill no longer draws a flag as text, so it no longer maps Incomplete's amber onto the filter tone `yellow`.)
- **Exempt is the only decision flag; Absent is a marker (Graham, 21 Oct 2026, reversing the ruling above it was first written under).** Code 1 means "not doing this task": never owed, late, referred, made up or waiting on feedback, no Extend button on the card, and setting it withdraws Prism's open records (`isExempt`, client and server). Absent (5) changes nothing in Prism's own tracking, because teachers use it differently ("their one chance" or "a reminder to follow up") and Prism assumes neither: no withdrawals, Extend stays, and make-ups, late work, feedback owed, the overdue clock and hidden feedback treat the student like an unflagged one. Incomplete, Missing and Late leave the work owed too. Absent keeps its symbol and slate color. The popover's first name is `preferredFirstName`.
- **Two final flags, three markers (Graham, 21 Oct 2026; built 22 Oct).** Exempt (1) and Missing (3) are final (`isFinalFlag`, `FINAL_FLAGS`): the card's rubric is grayed and locked with the "Exempt, rubric locked" badge, and they count as handled (`hasFeedback`, the feedback fingerprints, `gradingState`, `gradingStateOf`: feedback given, grading complete). Late (6), Incomplete (2) and Absent (5) are markers (`isMarker`): the rubric stays open with one quiet line above it, "Grading this work clears Late." (`.flag-marker-note`), the work stays in feedback owed and To grade until it is graded, and agent suggestions still stage. Publishing a grade over a marker clears it, as Schoology's own gradebook does: a scale score is sent with `exception: 0` (a score sent with a flag is removed), the rubric write clears it by itself, and Prism then retires the saved copy and takes the flag's status line off the comment. Over a marker, a rubric-only Publish sends a comment-free settle (`settleMarker: true`): Prism never writes the card's comment when the teacher did not change it, and the line comes off the fresh comment. Neither a score nor levels are written over a final flag (409 `FLAGGED`; a level write clears Exempt, Incomplete, Absent and Late in Schoology, probed 21-22 Oct; not probed under Missing), checked against Prism's row and a fresh read before the write. When the levels publish but the comment write after them fails, the card's error says so ("Levels published to Schoology; the comment was not saved (...). Publish again to send it.") and keeps the comment. Why: a marker is a note to the teacher, not a decision about the grade (spec "Decisions").
- **Missing's guide line names what the probes showed (22 Oct 2026):** "Scores this task as zero. Topic levels already entered still count." on an aligned task (`flagGuide(3, name, { aligned: true })`, `FlagSymbol aligned`), "Scores this task as zero." otherwise. Clearing Missing sends `grade: null`, so no 0 is left counting; that blanks the levels too, so Prism reads them fresh from Schoology, saves them into the copy first and offers them back.
- **What a flag does to the grade is said per flag:** Schoology removes the grade for Exempt, Incomplete, Absent and Late and counts Missing as zero (it keeps the levels); the rubric-hidden note and the lock badge's hover say which (`flagEffect`).
- **UI word "Exempt", never "Excused"** (Graham, 21 Oct 2026): the gradebook's own word on this account for code 1. Code 5 is **Absent** (prod already holds 13 rows of it). The timeline's submission line for code 1 reads "Exempt"; the PrisMCP state value stays `excused`, because it is a name clients may rely on.

- **Missing shows IE in the shared feedback view (Graham, 21 Oct 2026; built 22 Oct).** On the student page and the gradebook pop-up (both `AssignmentFeedback`), work marked Missing keeps its rubric (Exempt alone hides it) and shows IE on every topic, or every feedback row, when Schoology holds no levels for the task: the IE cell is the awarded one and carries a small Missing symbol (`FlagSymbol` code 3, `inline`, no name; `.rubric-cell-mark`), and one line sits above the rubric beside the named symbol, "Shown as IE because the work is marked Missing. Schoology holds no topic levels for this task yet." When levels do exist (Missing set over graded work) they show as they are, with no per-cell symbol, under "Marked Missing. These levels still count in the topic averages." A feedback-row task's row levels live only in Prism, so its lines say that instead (#40 review, 22 Oct): "Shown as IE because the work is marked Missing. No rubric rows are scored for this task yet." and "Marked Missing. These are the rubric rows Prism holds for this task." It is a display transform (`missingView`): nothing is written and the student page's per-topic summaries keep Schoology's own numbers; recording real IEs in Schoology is #175. The assessment card and the gradebook cell are unchanged.

## The Flags menu and panels (22 Oct 2026, #40)

- **One Flags pill, in the style of Schoology's gradebook button** (`FlagsMenu`, `.flags-pill`). It sits in the card header after Refer and before Extend, and, smaller (`size="sm"`, `.flags-pill--sm`), in the shared view's badge row (the gradebook pop-up and each task on the student page, on a current course only). Closed it reads "⚑ Flags ▾" with an accent outline, like the other header pills; with a flag set it shows the flag's disc (`FlagDisc`, no popover inside a button) and name, filled with the flag's pale color and a 2.5px ring in the flag's color (`--flag-c` / `--flag-c-bg`). Missing stays outlined on the card color, as its symbol is. Open (`aria-expanded`) it takes the selected look the other header pills use.
- **The menu** is a fixed dropdown under the pill (`.flags-menu`, z-index above the pop-up's overlay; placed in script so neither the card nor the pop-up clips it, kept inside a 16px gutter at phone width): the small-capitals subheading "Flag in Schoology", the five flags in `FLAG_ORDER` (Exempt, Late, Absent, Incomplete, Missing), each a disc, its name and its `flagGuide` line with the student's preferred first name, then a divider and the note "On graded work, Schoology removes the grade while a flag is set. Prism keeps a copy and offers to restore it when you clear the flag." The set flag is ticked (accent ✓, `aria-checked`) and its line reads "Choose again to clear it." Keyboard: focus starts on the ticked flag (else the first), arrow keys move and wrap, Home/End jump, Enter or Space chooses, Escape (or Tab) closes and gives focus back to the pill; a click outside or a scroll closes it.
- **Choosing reads Schoology first.** The pill is disabled while the fresh read (`GET /api/grade-flags`) and any write run, and stays so until the page has refetched the pair. If the fresh read differs from what the page shows (flag or score), nothing opens: "Changed in Schoology since Prism last read this task. Sync, then try again." beside the pill. Every failure shows there in `--danger` (`.flags-error`, `role="alert"`), and the pill keeps its previous state.
- **The panel** (`FlagPanel`) opens in the card's action-panel row (the slot Extend uses), or in a row under the shared view's badges (`.assignment-feedback__panel`). Title "Mark Sam exempt?" (the flag's verb). One field, "Reason for the student (optional)", with a live preview under it once a reason is typed: `Added to the top of Sam's comment: "Marked exempt on Thu 22/10. <reason>"` (today, `lineDate`, the reason made plain ASCII as the line will be). Then, in this order: "Also withdraws: Extension to Fri 24/10/2026" (Exempt only, when Prism holds open records); the saved-grade note on graded work as an amber note (`.flag-panel__saved`), "Schoology removes this grade while the flag is set. Prism keeps a copy: 75 / 100 and 2 topic levels. Your comment stays." (Missing: "Schoology sets this grade to 0 while the flag is set. ..."); a marker's next steps (Late, Incomplete, Absent, verbatim from the spec); then "Cancel" (`.ghost`) and "Mark exempt" (`.primary`). A flag that replaces a flag opens the same panel; when the grade is already in a waiting copy, the note names that copy.
- **The grade in words** comes from the server, one helper for every surface (`server/services/savedGrades.js` `gradeSummary`): a score-scale level with its points ("Exhibiting (75)"), else the points ("87.5 / 100"), then "N topic levels" and "N rubric row levels". The spec's "Exhibiting (3.5)" was a placeholder; Prism's scales are on points out of 100.
- **Clearing** the ticked flag with a copy waiting opens `ClearFlagPanel`: "Clear Exempt?", one box ticked by default, "Restore the saved grade as a draft: 2 topic levels" (what the card can stage; "(replaces your current draft)" when the card has one), "Re-enter in Schoology: 90" for the parts it cannot (a points-only score, an overall typed over the computed one), and "Cancel" / "Clear Exempt". With no copy, choosing the ticked flag clears at once and never restores (`restore: false`): a copy that clear keeps (clearing Missing set in Schoology over levels) is offered on the card instead. A restored copy is staged on the card as a draft (the pending count shows it) and goes to Schoology with the usual Publish. Prism never replaces a teacher's draft unannounced (review, 22 Oct 2026).
- **The card after a write:** the page refetches that student only (the other cards keep their drafts), the comment editor takes the comment Schoology now holds (an unsaved edit keeps the teacher's text, with the flag's line swapped on top), and the flag's symbol shows in the status area (`SubmissionStatusPill` draws the symbol with its name instead of a text pill, with the popover). A final flag's locked rubric draws the saved levels grayed (and a score-scale task's saved overall level), with the caption "Saved before the flag on Wed 21/10. Clear the flag to restore it." above it (`.flag-saved-caption`). With no flag set and a copy still waiting (cleared with the box unticked, or kept by a clear with no panel), a quiet line above the rubric says what it is, when it was saved and what a restore puts back: "Grade saved in Prism on Wed 21/10: 75 / 100 and 2 topic levels. Restoring puts back 2 topic levels as a draft.", with a `.ghost.accent` "Restore saved grade" (or, when nothing can be staged, the parts to re-enter in Schoology instead of the button). Over staged changes the button asks first, inline in the card (no browser dialog): "Restoring replaces your draft on this card with the saved grade (2 topic levels)." with `.primary` "Restore and replace your draft" and "Cancel". A copy is retired (no longer offered) by any published score or levels for the pair, flag or not: a newer grade makes it stale.
- **A final flag keeps staged levels as a draft (revised 22 Oct 2026, #40 review).** When Exempt or Missing lands on a card, its staged topic, row and overall levels stay in the card's draft (the comment and Display edits too), and one quiet line under the lock says so: "Your staged levels stay as a draft until the flag is cleared." (`.flag-marker-note`). Dropping them, the first build, lost the teacher's work for a flag that may be cleared the same day.
- **A flag's reason warns over a hidden comment (22 Oct 2026, #40 review).** A reason writes a status line, and publishing a line turns Display on, so when Display is off and the comment holds the teacher's own text (not only Prism's line), the Flags panel shows the same warning as Extend and Resubmit (`HiddenCommentWarning`, exported from `StatusLineModal.jsx`): "Their comment is hidden from the student. Publishing turns Display on, so your current hidden comment becomes visible to the student and parents. Edit or remove it in Schoology first if it isn't for them." The modal's form adds "(below)" and the re-read button. Publish all skips, rather than sends, a grade for a student on a final flag and names them in its result line ("Skipped Grace H: flagged Exempt in Schoology (clear the flag to publish a grade)."); the server's `FLAGGED` refusal stays as the backstop. Any error after the Schoology write (a read-back mismatch) still refetches the pair, and a failed refetch says "Saved, but the page could not refresh. Reload to see it." beside the pill.
- **The gradebook and the student page** refetch after a write (the gradebook, its topic levels and the triage panels; the student page and each course summary), and the open pop-up redraws from the fresh data. A flagged cell's symbol, the pop-up and the student page pass the saved grade in words (`saved_level`) and the flag's reason line (`flag_line`) to the popover. Where the shared view has the Flags pill, the pill carries a set flag, so the badge row drops its text flag badge (an archived course, with no pill, keeps it).

## Flag for review removed (21 Oct 2026, #40)

- **Graham dropped it completely.** The card header pill, its reason field, the "Review: ..." badge on the gradebook pop-up and the student page, the "Flag for review" refine pill, the "Flagged for review" Needs action reason and the "flagged" count in Triage's Unfinished grading all went, with the `flags` table (`DROP TABLE IF EXISTS flags` in `MIGRATIONS`) and `/api/flags`. The 8 stale automatic "Below 50%" flags in prod went with the table.
- **Kept, because they are different things:** the AI suggestion's reviewer flags (`reviewer_flags`, `reviewer_flags_brief`, the amber "Reviewer flags" tray) and the Ask to resubmit request (built from the `resubmissions` table; the student page still lists open requests under `flags`).
- **The card header slot went to the Flags menu** (all five flags; see "The Flags menu and panels" below), which sits after Refer and before Extend in the right-hand cluster.

