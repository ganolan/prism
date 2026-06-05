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

`client/src/pages/AssessmentSummaryPage.jsx` — `CELL_COLORS`, `HeaderPill`, the
control band, the comment publish indicator, and the whole-class command bar.
`client/src/app.css` — the semantic CSS variables and the existing `.badge` /
button classes.
