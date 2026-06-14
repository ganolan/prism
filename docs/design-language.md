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
  gradebook **Assessments list** and the submission-detail modal. Icon-only links
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
- **Block visibility:** the tray renders when any of narrative / flags / strengths /
  suggestions is present, so a flags-only row still shows its flags now that they no
  longer have an independent top-of-card home.
