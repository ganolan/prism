# Rubric Binding UX, Grid Polish & Rubric MCP Tools — Design

**Date:** 2026-06-08
**Status:** Draft (awaiting review)
**Related:** Follow-up to `docs/superpowers/specs/2026-06-08-rubric-descriptors-design.md` (the merged rubric-descriptors feature); #80 (Prism visual language), `docs/design-language.md`. Folds in "Project B" — the rubric MCP tools that the descriptors spec §8 carved out as a separate follow-up.

## 1. Problem & intent

The merged rubric-descriptors feature shipped the data model (5 tables), `/api/rubrics`, CSV import/export, the descriptor grid with a Compact↔Descriptors toggle, drag-reorder, and the fuchsia/sparkle suggestion accent. It deliberately left several pieces of approved-spec behaviour unbuilt, plus some latent rough edges. This spec finishes them and adds the rubric MCP tools.

The original spec §8 said the MCP tools live "in the PrisMCP repo" — that is stale. The MCP server is **`mcp/server.js` in this repo**, so the rubric tools are added here, reusing `server/services/rubricStore.js`.

### Goals
- **Complete the binding UX** (highest value): interactive mapping for unmatched criteria, and the ability to pick/reuse an existing rubric rather than only uploading a new CSV.
- **Library hygiene:** let the teacher delete (and export) rubrics so near-duplicate rubrics don't accumulate.
- **Descriptor-grid a11y/polish:** keyboard reorder + drop-target highlight, and move reorder out of the awkward "first student card only" handle.
- **Matching robustness (light touch)** and small rendering polish.
- **Rubric MCP tools** so an agent can push a teacher's rubric in (ordered, no Prism IDs).

### Non-goals
- Schema changes (the 5 tables already support all of this).
- Fuzzy/confidence-scored matching (explicitly rejected — see §6).
- Resolving #67 (APCSP classic rubrics).
- A separate full rubric-library page (spec §5 of the prior design kept management inline; the modal here honours that — it is an inline modal on the assessment page, not a route).
- Per-assignment row ordering (the prior spec's "reuse-with-different-order" extension stays out of scope; `position` remains a rubric-level property).

## 2. Decisions (settled in brainstorm, 2026-06-08)

| # | Decision |
|---|---|
| Scope | One spec: items 1–5 (UI) + the 3 rubric MCP tools as a final phase, all in this repo. |
| 1b | A **"Manage rubrics" modal** (tabbed: Attach · Map criteria · Row order), replacing the toolbar's inline template/upload links. Includes per-rubric **delete** (library hygiene) + export. |
| 1a | Map unmatched criteria as **step 2 (a tab) inside the modal**; reopening the modal is the revisit/override path. |
| 2 | Reorder lives in a **"Row order" tab in the modal** (single criterion list), not on the per-student grids. |
| 3 | **Light touch** matching — expand `normalizeTitle` framings; no fuzzy/confidence UI. |
| 4 | Mapping is **1:1** (one topic ↔ one criterion per rubric); enforced server-side. |
| 5 | Upload moves into the modal (resolving the `<label>`-as-button antipattern); uncovered-topic IE cell shows "Insufficient Evidence". |
| B | `write_rubric` **upserts by name** (re-pushing a name replaces, never duplicates). |

## 3. Data model

**No schema changes.** Existing tables (`rubrics`, `rubric_criteria`, `rubric_descriptors`, `rubric_attachments`, `rubric_attachment_topics`) already support everything below. The relevant invariant to enforce in code (not newly in schema): within one attachment, each `topic_id` maps to **at most one** `criterion_id` (the existing `UNIQUE(attachment_id, criterion_id)` already guarantees the converse).

## 4. Server changes

### 4.1 Delete a rubric (new)
- **Route:** `DELETE /api/rubrics/:id` → `deleteRubric(db, id)` (already exists in `rubricStore.js`; only the route + client method are missing).
- Deleting a rubric **cascades** to its criteria/descriptors and to `rubric_attachments` (and thence `rubric_attachment_topics`) — i.e. it un-attaches the rubric from every assignment using it. To make that safe and visible:
  - `listRubrics()` gains an **`attachment_count`** per rubric (a subquery like the existing `criteria_count`) so the modal knows, *before* the click, how many assignments each rubric is bound to and can warn ("attached to N assignments").
  - **Confirm-in-place** in the UI when N > 0 (design-language principle: destructive actions confirm in place).
- **Verify** `PRAGMA foreign_keys = ON` in `getDb()` so the cascade fires (the existing `detachAttachment` already relies on cascade; this is a confirmation, not new work — but assert it with a test).

### 4.2 1:1 mapping enforcement + unmap (item 4)
- `setMapping(db, attachmentId, criterionId, topicId)` gains **move-semantics**: before upserting `(attachmentId, criterionId)→topicId`, clear any *other* criterion in the same attachment currently mapped to `topicId`. This preserves "one topic ↔ one criterion" regardless of caller.
- Support **unmap**: a null/empty `topicId` deletes the `(attachmentId, criterionId)` row. The `PUT /api/rubrics/attachment/:attachmentId/mapping` route accepts a null `topicId`.

### 4.3 `normalizeTitle` framings (item 3 — light touch)
`server/services/rubricMatch.js` `normalizeTitle` additionally strips, before the alphanumeric collapse:
- numbered `Standard N:` (not only `Anchor Standard N:`),
- framework code prefixes such as `VA:Cr1.1`, `MA:Pr5.1` (letters `:` alnum/dots),
- leading list numbering: `1.`, `1)`, `1 -`.

`autoMatch` (exact-normalized + `external_id` exact) is otherwise unchanged. A test per framing. Conservative by intent — over-stripping risks two distinct topics colliding; the interactive Map-criteria step absorbs any residual miss in one click.

## 5. Client — modal, grid, page

### 5.1 `RubricManagerModal.jsx` (new)
Replaces the toolbar's `Download template` link and `Upload rubric CSV` `<label>` with a single **"Manage rubrics…"** button that opens a tabbed modal. Tabs: **Attach · Map criteria · Row order**; the latter two are enabled only when a rubric is attached to the current assignment.

- **Attach tab** — list of existing rubrics from `listRubrics()` (name · `criteria_count` · `updated_at`). Per row: **Attach** (`attachRubric`), **Export** (⬇, links `rubricExportUrl(id)`), **Delete** (🗑, confirm-in-place when attached). Below the list: an **upload dropzone** backed by a **button-triggered hidden file input** (not a styled `<label>` — resolves item 5b) calling `uploadRubricCsv` then `attachRubric`; and a **Download template** link. The currently-attached rubric is marked (✓).
- **Map criteria tab** — every criterion of the attached rubric, auto-matched ones pre-filled with their topic + ✓, misses flagged ⚠. Each is a **1:1-constrained `<select>`** offering only **still-unmapped** topics + its own current pick + a "— none —" (unmap) option. Persists per change via `setRubricMapping(attachmentId, criterionId, topicId)`. Also the place to **override** an auto-match.
- **Row order tab** — a single criterion list (criterion name + mapped topic + a 1-line ED-descriptor preview), reordered via the shared `ReorderableList`. Persists via `reorderRubricCriteria(rubricId, orderedCriterionIds)`; all student grids re-render in the new `position` order.

The modal reads `rubricData` (current attachment incl. `attachmentId`, `rubric.criteria` with `standard_title`, and `topicByCriterion`) and the assignment's `alignedTopics` (id + title for the dropdowns). It calls back to the page to refresh `rubricData` after any attach/map/reorder/delete.

### 5.2 `ReorderableList.jsx` (new, generic)
The drag + keyboard reorder a11y core, testable in isolation:
- **Drag:** grip handle; **drop-target highlight** (a blue inset line / row highlight) follows the pointer during drag.
- **Keyboard:** a focused row + **↑/↓ buttons** (and ArrowUp/ArrowDown keys) move it, with a visible focus ring; commits the new order on each move.
- Emits an ordered id array to its `onReorder` callback. No persistence knowledge of its own.

### 5.3 `RubricDescriptorGrid.jsx` (simplify)
- **Remove** `onReorder`, the `dragFrom` ref, the row drag handlers, and the grip `<span>` — reorder has moved to the modal, so the grid becomes grading-only.
- **Row key** → `` `${topic.id}-${criterion?.id ?? 'none'}` `` (item 4: defensive even though 1:1 makes a `topic.id` collision impossible).
- **Uncovered-topic IE cell** (a topic with no criterion → `criterion = null`): render the muted **"Insufficient Evidence"** default in the IE column instead of leaving it blank (item 5a). Other levels stay blank for uncovered topics.

### 5.4 `AssessmentSummaryPage.jsx`
- Owns the modal open-state and `rubricData`; provides the refresh-after-change callbacks. The `idx === 0 && rubricData ? onReorder : undefined` hack and the `reorderRubricCriteria` call inline on the first card are **removed** (reorder now lives in the modal). The toolbar's template/upload affordances collapse to the single "Manage rubrics…" button.

## 6. Project B — rubric MCP tools (final phase)

Added to `mcp/server.js` (`registerTool`) + `mcp/handlers.js`, following the existing tool conventions (zod `inputSchema`, JSON-text content), reusing `rubricStore.js`:

- **`list_rubrics`** → `listRubrics(getDb())`: `{ name, source, criteria_count, updated_at }[]`. Name is the agent's handle (no Prism id needed).
- **`read_rubric({ name })`** → the **portable shape**, ordered by `position`, **no Prism IDs**:
  ```
  { name, criteria: [ { criterion_name, standard_title, reporting_category,
                        descriptors: { ED, EX, D, EM, IE } } ] }
  ```
  (the JSON twin of `exportRubricCsv`). On duplicate names, newest (`updated_at`) wins.
- **`write_rubric({ name, criteria: [...] })`** → **upsert by name**: if a rubric with `name` exists, replace its content; else create. The `criteria` array is **ordered** → `position = index + 1`. IE defaults to "Insufficient Evidence" (already handled by the store). Upsert-by-name keeps the library free of re-run duplicates — complementing the modal's delete.

New thin helper in `rubricStore.js`: `upsertRubricByName(db, content)` resolving name → existing id (newest) → `saveRubric(db, content, id)` (replace) or create. CSV upload behaviour is unchanged (it stays create-new; the teacher prunes via the modal). Resource mirrors (`prism://rubrics`, `prism://rubric/{name}`) are an optional nicety, not in core scope.

## 7. Sequencing (TDD throughout)

1. **Server foundations** — `normalizeTitle` framings; `setMapping` 1:1 move-semantics + unmap; `DELETE /api/rubrics/:id` + attachment-count; FK-cascade assertion. Tests: `rubricMatch.test.js`, `rubricAttach.test.js`, `rubrics.test.js`.
2. **Modal + grid + page** — `ReorderableList` (a11y), `RubricManagerModal` (3 tabs), grid simplification (key + IE + drop reorder props), page wiring. Tests (React Testing Library): new component tests, `RubricDescriptorGrid.test.jsx`, `AssessmentSummaryPage.test.jsx`. Add client `deleteRubric(id)` to `services/api.js`.
3. **Rubric MCP tools** — `upsertRubricByName` + `list_rubrics` / `read_rubric` / `write_rubric`. Tests: `rubricStore.test.js`, `mcp/server.test.js` / `mcp/handlers.test.js`.

Each step is red → green → refactor with tests beside the module. New code reuses documented primitives (`.help-dot`, `.number-stepper`, button classes, fuchsia tokens); colours stay config-driven via `var(--…)`.

## 8. Visual language (#80)

Log in `docs/design-language.md`: the **tabbed rubric-manager modal** (Attach · Map criteria · Row order as the single rubric-editing hub), the **reorder interaction** (grip + ↑/↓ keyboard + focus ring + blue drop-target line) as a reusable `ReorderableList` pattern, and the **confirm-in-place delete** of an attached rubric. Dates rendered `en-GB` per the date-formatting convention.

## 9. Open questions / risks

- **Delete of an attached rubric** un-attaches it everywhere (cascade). The attachment-count warning + confirm-in-place mitigate; confirm this is the desired behaviour (vs. blocking delete while attached). *Assumed: warn + allow.*
- **Duplicate rubric names** are possible (no `UNIQUE(name)`). `write_rubric` upserts by newest match and the modal's delete keeps things tidy; we deliberately do **not** add a name-uniqueness constraint (CSV upload stays create-new). Revisit if duplicate-name confusion appears in practice.
- **`normalizeTitle` over-stripping** could collide two distinct topics; kept conservative, and the Map-criteria step makes any miss a one-click fix.
- **Map-criteria override** of an auto-match relies on freeing the target topic first (dropdowns hide taken topics); `setMapping` move-semantics make a direct reassignment safe even if a caller bypasses the dropdown.
