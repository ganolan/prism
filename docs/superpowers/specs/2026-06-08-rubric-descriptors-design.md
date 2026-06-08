# Rubric Descriptors on the Assessment Summary Page — Design

**Date:** 2026-06-08
**Status:** Draft (awaiting review)
**Related:** #80 (Prism visual language), `docs/design-language.md`; complements but does **not** resolve #67 (classic-rubric criteria for APCSP via internal `all_rubrics`). This feature covers **SBG measurement-topic descriptors via teacher-authored CSV/MCP**, a different rubric model than #67's classic rubrics.

## 1. Problem & intent

`AssessmentSummaryPage` is the standards-based-grading (SBG) grid: rows = measurement topics, columns = proficiency levels (`ED/EX/D/EM/IE`). Today each cell shows only a level code. Teachers want the **rubric descriptor prose** for each (topic × level) shown in the grid, so the descriptor that defines each level is visible while grading.

That prose does not exist anywhere in Prism, and #67's internal `all_rubrics` endpoint returns empty for SBG sections. So the descriptors must be **authored by the teacher** and imported. The design must also let **other teachers** (and the MCP) get their rubrics in by **copy-paste, with no knowledge of Prism's internal IDs**.

### Goals
- Import teacher-authored rubric descriptors via **CSV upload** (and later the MCP) and render them in the assessment grid.
- Keep the import **portable**: the CSV is a near-copy of rubrics teachers already have; no Prism IDs required.
- Preserve the author's **intentional row order**.
- Settle and apply Prism's grid **visual language** (suggestion accent, selection borders, headers) as a reusable reference for future work (#80).

### Non-goals (this spec)
- Building the MCP rubric tools (separate follow-up spec in the PrisMCP repo — schema here serves it).
- Resolving #67 (APCSP classic rubrics).
- A configurable app-wide locale (separate deferred follow-up).

## 2. Core principle: portable content vs. local binding

A rubric splits into two layers:
- **Portable content** — the rubric, its criteria, and per-level descriptors. School-agnostic, references no Prism IDs. This is what CSV import and the MCP write.
- **Local binding** — attaching a rubric to an assignment and mapping each criterion to one of that assignment's measurement topics. References Prism IDs; established per-assignment, auto-derived.

This keeps rubrics shareable by plain copy-paste and confines all ID knowledge to the attach step.

## 3. Data model (5 tables, `CREATE TABLE IF NOT EXISTS`)

**Portable content:**

```
rubrics
  id            INTEGER PK
  name          TEXT NOT NULL
  source        TEXT            -- 'csv' | 'mcp' | 'manual'
  notes         TEXT
  created_at    TEXT
  updated_at    TEXT

rubric_criteria
  id                 INTEGER PK
  rubric_id          INTEGER NOT NULL REFERENCES rubrics(id) ON DELETE CASCADE
  position           INTEGER NOT NULL   -- canonical, intentional row order (1..N)
  criterion_name     TEXT               -- friendly label, e.g. "UI/UX"
  standard_title     TEXT               -- measurement-topic title as written by the author
  reporting_category TEXT               -- as written, e.g. "Produce"

rubric_descriptors
  id           INTEGER PK
  criterion_id INTEGER NOT NULL REFERENCES rubric_criteria(id) ON DELETE CASCADE
  level        TEXT NOT NULL            -- 'ED' | 'EX' | 'D' | 'EM' | 'IE'
  descriptor_text TEXT
  UNIQUE(criterion_id, level)
```

`IE` defaults to the literal "Insufficient Evidence" when absent from the source.

**Local binding:**

```
rubric_attachments
  id                    INTEGER PK
  rubric_id             INTEGER NOT NULL REFERENCES rubrics(id) ON DELETE CASCADE
  assignment_schoology_id TEXT NOT NULL
  course_id             INTEGER REFERENCES courses(id)
  created_at            TEXT
  UNIQUE(assignment_schoology_id)        -- one rubric attached per assignment

rubric_attachment_topics
  attachment_id INTEGER NOT NULL REFERENCES rubric_attachments(id) ON DELETE CASCADE
  criterion_id  INTEGER NOT NULL REFERENCES rubric_criteria(id) ON DELETE CASCADE
  topic_id      TEXT NOT NULL REFERENCES measurement_topics(id)
  UNIQUE(attachment_id, criterion_id)
```

A rubric is a **global, reusable library object** in the local DB — attachable to any assignment in any course.

Criterion↔topic mapping is **1:1** (each criterion binds to one topic; each topic at most one criterion).

## 4. CSV template + import/export (round-trippable, portable)

**Columns** (mirror the teacher's existing rubric for copy-paste):

`Criteria, Reporting Category, Standard, Exhibiting Depth, Exhibiting, Developing, Emerging, Insufficient Evidence`

- `Standard` = the measurement-topic title as written (a leading `"Anchor Standard N: "` prefix is tolerated/stripped on match).
- `Insufficient Evidence` is optional → defaults to "Insufficient Evidence".
- Optional `External ID` column (e.g. `ART.5.1`) for power users wanting exact binding; never required.

**Import:** parse → create/update a named rubric (name from a prompt on upload, default from filename) → one `rubric_criteria` row per CSV row **in file order** (`position` = 1..N) → `rubric_descriptors` from the level columns.

**Export:** "Export rubric to CSV" emits the same column format (edit/share/re-import; identical to the MCP's read shape). **Download template** hands out the blank header row (+ one example row).

A fixed-capability helper (`scripts/` or a route) owns parsing; no ad-hoc shell parsing.

## 5. Attach + auto-match binding

Lives **inline on `AssessmentSummaryPage`** (the upload button + template link the teacher asked for); no separate library page in this iteration (YAGNI — revisit if managing many rubrics becomes painful).

Flow: **Attach rubric** → pick an existing rubric **or** upload a CSV (creates + attaches). On attach:
1. **Auto-match** each criterion to one of the assignment's aligned topics by **normalized title** (lowercase, collapse whitespace, strip punctuation and a leading `"Anchor Standard N:"`); `External ID` exact match wins when present.
2. **Unmatched** criteria → a compact dropdown of the assignment's topics (human-readable titles).
3. Persist to `rubric_attachment_topics`. Done once per attachment.

No Prism-internal knowledge required of the teacher at any step.

## 6. Row ordering

- `rubric_criteria.position` is the **canonical, intentional order**, seeded from CSV/MCP source row order — preserving the assignment's task sequence even when it differs from the natural measurement-topic order.
- The grid renders rows in **`position` order** (criterion → mapped topic), **not** topic order. Topics not covered by the rubric render afterward in natural order.
- **Manual reorder:** drag handles on rows in the descriptor view persist new `position` values. Order lives on the reusable rubric, so reordering updates it for every assignment the rubric is attached to.
- **Known extension (not built):** if a single rubric must be ordered differently on two assignments, move `position` onto `rubric_attachment_topics`. Out of scope now.
- MCP `write_rubric` takes an **ordered** criteria array; order round-trips on read/write.

## 7. Rendering & visual language

**Page-level toggle: Compact ↔ Descriptors, default Descriptors.** Compact = today's level-code grid (fast grading); Descriptors = the full grid below.

**Descriptor grid (signed-off):**
- Reporting-category colour on the **topic column only** (`#B4A7D6` Produce, `#9FC5E8` Create/Respond/Connect); **descriptor cells neutral white**.
- **Colour-coded level headers with full wording**, no abbreviations.
- **AI suggestion:** Fuchsia `#e21ad6` (wash `#fbe6fb`), no border — the `ai-sparkle.svg` 3-star glyph (`fill: currentColor`) at a 17px top-right corner; persists when the cell is also selected. **Matched** on the suggested-comment field and the reviewer-analysis drawer.
- **Selection borders, inset/hugging the cell edge:** final = solid inset 2px in the level colour; draft = dashed `outline-offset:-1px`; staged-deletion = red **dotted** `-1px` + a 21px corner `×`, white background.
- IE cell shows muted "Insufficient Evidence".

**Config:** the reporting-category palette and the fuchsia suggestion token live in `config.yaml` (Art & Design defaults today; editable per subject). These tokens are also logged in `docs/design-language.md` (#80).

## 8. PrisMCP — follow-up spec (not built here)

`list_rubrics` / `read_rubric(name)` / `write_rubric(name, criteria[])` over `rubrics`/`rubric_criteria`/`rubric_descriptors`, in the PrisMCP repo. Lets an agent push a teacher's rubric in (ordered) with no ID knowledge. The schema above already serves it.

## 9. Feature flag & testing

- New surface behind a `config.yaml` feature flag (consistent with other enrichment tools).
- **Server:** CSV parse (incl. file-order → `position`, IE default, optional columns), normalized auto-match, attachment/mapping upsert, CSV round-trip (import→export→import is stable). `*.test.js` beside each module.
- **Client:** the Compact↔Descriptors toggle, descriptor rendering (incl. ordering by `position`), the attach + dropdown binding UI, and drag-reorder. React Testing Library.
- No API-shape change → no parity probe needed.

## 10. Decomposition / sequencing

1. **This spec (Prism repo):** schema → CSV template/import/export → attach + auto-match → descriptor rendering + toggle + reorder → visual tokens in config + design-language doc.
2. **Follow-up spec (PrisMCP repo):** the rubric MCP tools, once the content tables are stable.

## 11. Open questions / risks

- **Reuse-with-different-order** edge case (§6) — confirm rubric-level ordering is acceptable.
- **Normalized title matching** can mis-match if a teacher's wording diverges from the synced topic title; the dropdown fallback + optional `External ID` mitigate. Surfacing match confidence in the binding UI is a possible nicety.
- **Attach cardinality** — assumes one rubric per assignment (`UNIQUE(assignment_schoology_id)`); revisit if an assignment ever needs two rubrics.
