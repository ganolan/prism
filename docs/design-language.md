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
colour carries grade meaning, so it stays inline (`CELL_COLORS` in the page):

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

### Status pill (header flags — `HeaderPill`)
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
Sync dialog's recent-only control (June 2026).
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
- **Theme coverage.** Confirm the semantic roles hold across all themes incl.
  dark and any colour-blind-friendly theme (verify `--success`/`--warning`/
  `--danger` contrast and distinguishability).
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

`client/src/pages/AssessmentSummaryPage.jsx` — `HeaderPill`, the control band, the
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
  *Flag for review*, *Ask to resubmit*. Semantics: **OR within a group, AND
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
  FeedbackPage's status filter, and AssessmentSummaryPage's Descriptors /
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
  import, sync config) stay desktop tools.


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
header. Each run is a full-width `.ghost` row button (`aria-expanded`): **start date/time** (bold,
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

**Card control (`ResubmitControl`, `.resubmit-control`).** Lives in the assessment card's header next
to "Flag for review". No open request: a plain pill button, "⟳ Ask to resubmit". An open request:
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
