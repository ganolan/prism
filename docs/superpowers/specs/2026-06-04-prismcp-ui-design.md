# PrisMCP UI — surfacing reviewer suggestions on the assessment page

**Date:** 2026-06-04
**Related issues:** extends/supersedes [#64](https://github.com/ganolan/prism/issues/64); follow-up [#78](https://github.com/ganolan/prism/issues/78)
**Visual source of truth:** `docs/ui-design/PrisMCP-update/mockups/` (the build must match these closely)
**Sample input:** `docs/ui-design/PrisMCP-update/ai-assisted-grading-output-sample.md`

## Scope

This is **Project A — the UI layer only**. It renders reviewer suggestions, flags, and
assessment-wide noticings that already exist in the local `feedback` table (and a small new
`assessment_analysis` record). It is independent of *how* those rows arrive.

Out of scope, tracked separately:

- **PrisMCP (Project B)** — the MCP server that lets an external grading agent read roster/draft
  data and write suggestions into the DB (two-way). Its own brainstorm/spec. The UI here is the
  render target for whatever PrisMCP writes; nothing in this spec depends on it (the existing
  `inbox/` JSON ingestion can seed the same rows for development).
- **Final-grade distribution + unified Analysis drawer** — [#78](https://github.com/ganolan/prism/issues/78).
- **Descriptor text replacing ED/EX codes in cells** — a future update. The cell language here is
  built so it already works with descriptor text (see mockup 01, second table), but wiring the
  descriptors in is not part of this work.

This supersedes the surfacing approach in the #64 spec. The one behavioural change from #64: a
suggestion overlay is **never suppressed** when a cell is already current/pending — teacher marks
and suggestions must coexist (see §3).

## Mockups (visual source of truth)

| File | Covers |
|---|---|
| `mockups/01-rubric-cell-language.html` | Three-way cell language: final / draft / suggestion, incl. the agree-case |
| `mockups/02-student-card.html` | Per-student card: flags strip, hero comment, control band, suggestion box |
| `mockups/03-reviewer-analysis-drawer.html` | Sticky header, conditional Reviewer Analysis button, drawer |
| `mockups/04-noticings-panel-and-placements.html` | Noticings panel content + placement exploration |

These are static HTML built during brainstorming. CSS values below are authoritative; where this
doc and a mockup disagree, this doc wins, but they should not disagree.

> **Local-only:** the `docs/ui-design/PrisMCP-update/` folder (these mockups and the grading
> sample) is **gitignored** because it contains real student names and grades. The files live on
> disk at the paths above for reference but are not in git history. This spec carries every
> authoritative value, so the build does not depend on the mockups being committed.

## 1. Colour system

Replaces the current "all selections solid green" scheme. The rubric keeps its colours **inline**
(as today's `LEVEL_COLORS` does) rather than moving to `app.css` tokens — a deliberate local
exception, consistent with the existing rubric code and the #64 note.

Per measurement level, five families. **Header tint = final fill.** Cell text is always
**black (`#1a1a1a`)** because descriptor text will later replace the level codes, so colour cannot
carry meaning in the text.

| Level | Header & Final fill | Draft fill | Final border (2px solid) | Draft border (2px solid) |
|---|---|---|---|---|
| ED | `#bfdbfe` | `#eff6ff` | `#2563eb` | `#93c5fd` |
| EX | `#bbf7d0` | `#f0fdf4` | `#16a34a` | `#86efac` |
| D  | `#fef08a` | `#fefce8` | `#ca8a04` | `#fcd34d` |
| EM | `#fed7aa` | `#fff7ed` | `#ea580c` | `#fdba74` |
| IE | `#fecaca` | `#fef2f2` | `#dc2626` | `#fca5a5` |

**Suggestion accent (violet — deliberately *not* yellow, because Developing is already yellow):**

- Cell fill (suggestion present, no teacher mark): `#ede9fe`
- Dashed ring: `1px dashed #a78bfa`, drawn with `outline` + `outline-offset: -3px` so it nests ~1px inside the cell border
- ✦ glyph: `#8b5cf6`
- The suggested-comment box and the Reviewer Analysis accents reuse this violet so a teacher's eye
  correlates "violet cell hint" ↔ "violet comment suggestion" ↔ "Reviewer Analysis".

## 2. Rubric cell language

Header row: each level header uses its **Header tint**, black text, with the short label
(`Exhibiting Depth`, etc.) beneath the code — as today.

Body cell states and precedence (a cell can be in several at once):

- **Final** — `background: <Header/Final fill>`, `border: 2px solid <Final border>`, `font-weight: 700`.
- **Draft** — `background: <Draft fill>`, `border: 2px solid <Draft border>`.
- **Suggestion** — `outline: 1px dashed #a78bfa; outline-offset: -3px;` plus, *when there is no
  teacher mark in that cell*, `background: #ede9fe`; plus the ✦ glyph top-right.
- **Empty** — default card background, 1px grey grid border.

**Coexistence (the core rule).** Teacher mark and suggestion never replace each other:

- Usually they fall on different cells in a row (teacher picked one level, the agent suggested
  another) and simply sit side by side.
- When they fall on the **same** cell (the agree-case), the cell renders **all three at once**:
  the teacher's solid border on the perimeter, the dashed violet ring nested ~1px inside it, and
  the ✦. The teacher's fill wins (no violet wash over a finalized cell). See mockup 01, Row 1 —
  cell class `f-ED ai`.

**Implementation notes:**

- The colored 2px borders must override the grey grid line. Scope the selectors so they beat the
  base `.rub td` rule (e.g. `.rub td.f-ED`, not `.f-ED`) — a plain class loses on specificity to
  `.rub td` and the border silently won't render.
- Bordered cells need `position: relative; z-index: 2` so the colored border paints over a
  neighbouring header/cell border at shared corners (collapsed-border paint precedence).

## 3. Rubric interaction

Current behaviour: click a cell → set `pending` (draft); clicking again does nothing; finals can't
be cleared from the UI. New behaviour:

- **Clear a draft** — clicking the already-drafted cell again **clears** that topic's pending
  selection (toggle off, back to default/whatever the synced state is).
- **Stage a final for removal** — clicking a cell that is currently a synced **final** stages its
  removal: the cell drops all colour back to default and shows a **removal marker** —
  `outline: 1.5px dashed #ef4444; outline-offset: -3px;` + a small red `✕` top-right — so a staged
  removal is visibly a *pending change*, distinct from a never-set cell. On **Update Schoology**,
  the score is cleared in Schoology. (Mockup 02, "Proposed rubric click behavior".)

Accepting a suggestion is just a normal cell click on the suggested level → flows into `pending` →
draft → Update Schoology. There is **no "Accept rubric" button** — making the teacher click each
cell keeps them deliberating on the proposed proficiency. Removal staging participates in the same
`pending`/draft/`Update Schoology` lifecycle.

## 4. Per-student card (`StudentRubricCard`)

Top-to-bottom (mockup 02):

1. **Reviewer flags strip** — *above* the rubric. One generic, collapsible `<details>` strip,
   default **collapsed**, subtle amber (`#fffbef` / border `#e6c98a`, summary text `#92740f`).
   Label: `⚑ Reviewer flags` with **no count** (the flags are free-form prose, not enumerable —
   see the sample, where one student appears under several themes). Body = the prose from the
   feedback row's `reviewer_flags`. The strip renders only when `reviewer_flags` is present.
2. **Rubric** — the grid from §2/§3.
3. **Overall Comment** — the hero. Bolder label, larger textarea (`font-size: 0.84rem`,
   `1.5px` border). Teacher's editable comment, draft-persisted as today.
4. **Control band** — directly under the comment (creates the boundary that makes the comment the
   focus). Left-to-right:
   - `Update Schoology` (primary)
   - **Display to student** — reduced to an **eye icon + the toggle switch**, `title="Display to student"` (no text label)
   - **Discard changes** — a **trash icon**, `title="Discard changes"`, **always shown**, greyed/disabled when no pending changes
   - `↑ Use suggestion` — violet; copies the suggested feedback **up** into the comment textarea
     (overwrites); appears **only when a suggestion exists**
5. **Suggested feedback** box — below the band. Quiet and **unbranded**: no "AI", no "not yet
   applied". Muted grey-violet (`#faf9fd` / border `#e6e1f3`), small header `✦ Suggested feedback`,
   body text `#716b85`. Read-only. Renders only when a suggestion exists.

`Use suggestion` runs the text through the existing `normalizePastedText()` before applying, to
match pasted-comment cleaning, and overwrites the current comment.

## 5. Data model & endpoints

### Per-student suggestions

Reuse the existing `feedback` table. Relevant `feedback_json` shape the UI reads per row:

```jsonc
{
  "narrative_feedback": "string",                 // → Suggested feedback box / Use suggestion
  "rubric_scores": { "<topic key>": "ED|EX|D|EM|IE" }, // → rubric suggestion overlay
  "reviewer_flags": "string (prose) | null",      // → Reviewer flags strip
  "strengths": ["..."], "suggestions": ["..."]    // optional, already supported
}
```

`rubric_scores` → measurement-topic mapping (carried from #64): match each key against the topic's
`external_id` first, then `title` (case-insensitive); value must be one of `ED/EX/D/EM/IE`.
Unmatched keys or out-of-set values are ignored for the overlay (logged, never blocking).

**Load:** add `GET /api/feedback/for-assignment/:assignmentId` → all `status IN ('draft',
'teacher_modified')` rows for the assignment, keyed by `student_id`, each with parsed
`feedback_parsed`. One request per assessment page, mirroring how mastery loads via
`GET /api/mastery/:courseId/assignment/:assignmentId`. `AssessmentSummaryPage` fetches it alongside
`getMasteryForAssignment` and hands each card its row.

### Assessment-wide noticings

The **proposed score distribution** needs no new storage — it is **computed client-side** by
aggregating the loaded `feedback_parsed.rubric_scores` across students, per topic.

The **prose noticings** (AI-use pattern, integrity, structural notes) and the optional
**moderation note** are assessment-level. Add a minimal record:

```
assessment_analysis
├── assignment_id INTEGER PK REFERENCES assignments(id)
├── analysis_json TEXT NOT NULL   -- { noticings: [{title, body}], moderation_note?: string }
├── created_at TEXT
└── updated_at TEXT
```

Read via `GET /api/feedback/analysis/:assignmentId` (returns the parsed record or `null`).
Population is shared with Project B; for development it is seeded by extending the existing inbox
ingestion to capture the grading output's "Teacher Summary" block. (Ingestion changes beyond the
read contract are out of scope here.)

## 6. Reviewer Analysis drawer

On `/assessment/:id` (mockups 03, 04):

- **Sticky page header.** Make the existing header (`AssessmentSummaryPage.jsx` ~L862–881) sticky
  so it stays on scroll. **Remove the proficiency legend block** (~L883–898) — every rubric already
  shows the level headers, and the legend's hint text (`green border = pending · solid green =
  current`) is now stale.
- **Button.** Add `✦ Reviewer Analysis` at the right of the header (violet:
  `#ede9fe`/`#c4b5fd`/`#6d28d9`). It renders **only when an agent analysis exists** for the
  assignment — i.e. at least one draft/`teacher_modified` feedback row and/or an
  `assessment_analysis` record. **No presence dot.**
- **Drawer.** Slides in from the right over a dimmed overlay; closes via ✕ or overlay click.
  Header tagged **not student-facing**. Contents, top to bottom:
  1. **✦ Proposed score distribution** — one horizontal stacked bar per measurement topic, segments
     coloured by the level Header tints, each labelled with its count. A one-line clarifier:
     *"From the reviewer's suggested grades — not final entered scores."* Optional amber moderation
     note beneath (from `analysis_json.moderation_note`).
  2. **Noticings** — the prose blocks from `analysis_json.noticings` (title + body each).

## 7. Two-way flow

No new UI. A teacher types a draft comment / sets draft proficiencies; an external agent (via
PrisMCP, Project B) reads them and writes an updated `feedback` row; it surfaces through the exact
same Suggested-feedback box and rubric overlay defined above. The UI is symmetric by construction.

## 8. Status lifecycle

- Accepting a suggestion (cell click) or `Use suggestion` produces `pending` changes → card shows
  Update Schoology enabled (as today).
- On successful Update Schoology, flip the row's status: any teacher edit/accept → `teacher_modified`;
  a completed Update Schoology → `approved`. `approved` rows are filtered out server-side (§5) so
  they stop re-surfacing as suggestions.

## 9. Testing

- **Server:** `GET /api/feedback/for-assignment/:assignmentId` returns parsed rows keyed by
  `student_id`, excludes `approved`; `GET /api/feedback/analysis/:assignmentId` returns the parsed
  record or `null`.
- **Client (`AssessmentSummaryPage.test.jsx`):**
  - Suggestion overlay renders for a resolvable `rubric_scores` entry and **coexists** with a
    current/pending mark on the same row (agree-case keeps solid border + dashed ring + ✦).
  - Clicking a drafted cell again clears it; clicking a final stages removal (removal marker shown).
  - Suggested-feedback box + `↑ Use suggestion` appear only when a suggestion exists; Use suggestion
    overwrites the comment with normalized text and arms pending changes.
  - Reviewer flags strip renders only when `reviewer_flags` present; default collapsed.
  - Reviewer Analysis button renders only when an analysis exists; drawer shows the computed
    proposed distribution and the noticings; absent otherwise.
  - An unresolvable `rubric_scores` key renders no overlay and does not throw.

## 10. Verification

- `cd client && npx vite build`
- `npx vitest run server/`
- `npx vitest run client/src/pages/AssessmentSummaryPage.test.jsx`
- Manual: seed a draft feedback row (+ an `assessment_analysis` record) for an assignment, open
  `/assessment/:id`, confirm the cell language, the coexisting agree-case, clear-draft and
  stage-removal interactions, the suggestion box + Use suggestion, the reviewer-flags strip, and the
  Reviewer Analysis drawer with the proposed distribution + noticings. Compare against the mockups.

## Out of scope

- PrisMCP server / ingestion beyond the read contract (Project B).
- Final-grade distribution and the unified neutral-`Analysis` ↔ violet-`Reviewer Analysis` drawer
  ([#78](https://github.com/ganolan/prism/issues/78)).
- Descriptor text replacing level codes in cells (future; cell language is already compatible).
- Bulk "accept all suggestions" across students.
