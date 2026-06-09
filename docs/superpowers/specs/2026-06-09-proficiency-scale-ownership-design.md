# Prism owns the proficiency↔gradebook-score mapping

**Date:** 2026-06-09
**Status:** Design — approved direction, pending spec review
**Scope decision:** Full unify (server + client) — one config-backed scale as the single source of truth.

## 1. Problem & principle

The `assessment-grader` plugin (an MCP caller) grades student work and emits, per
measurement topic, a **proficiency level only** — one of
`Exhibiting Depth / Exhibiting / Developing / Emerging / Insufficient Evidence`
(`ED / EX / D / EM / IE`). It never computes gradebook points.

In a real run the AI grader **reverse-engineered** the level→points scale
(`ED=100 / EX=75 / D=50 / EM=25 / IE=0`) by inspecting two already-graded
students' numeric scores, because it believed it needed points to proceed. That
mapping leaked because it is not cleanly owned and encapsulated on the Prism side.

**Principle:** Neither the MCP caller (the AI grader) nor the teacher should need
to know, supply, or infer the proficiency↔gradebook-score mapping. Callers emit
levels. Teachers review and publish in levels. Prism converts to whatever the
gradebook / Schoology needs, internally, from a single configurable source.

## 2. Verified ground truth — there are THREE numeric scales

This was confirmed against the code (not assumed). The same five levels exist in
three distinct numeric encodings, and **two of them are write-bearing to Schoology**:

| Level | `points` (per-assignment observation) | `grade_scaled` (per-objective rollup / override) | banding cutoff | label |
|---|---|---|---|---|
| ED | 100 | 87.50 | ≥ 87.5 | Exhibiting Depth |
| EX | 75  | 62.50 | ≥ 62.5 | Exhibiting |
| D  | 50  | 37.50 | ≥ 37.5 | Developing |
| EM | 25  | 12.50 | ≥ 12.5 | Emerging |
| IE | 0   | 0.00  | < 12.5 | Insufficient Evidence |

- **`points` (0–100)** — the per-(student, assignment, topic) observation score.
  Stored in `mastery_scores.points`. Written to Schoology's `/observations`
  endpoint by `AssessmentSummaryPage.buildGradeInfo()`
  (`{ grade: String(points), gradingScaleId: 21337256 }`). Surfaced **bare** in
  `get_assignment_context.current_scores.points` — **this is the number the AI
  grader read off to reverse-engineer the scale.**
- **`grade_scaled` (0–87.5)** — Schoology's per-objective rollup value and the
  value written by the per-objective override path (`writeMasteryOverride` →
  `outcome-override`, validated in `mastery.js`, mapped client-side in
  `OverridePopup.SCALED_FOR_LEVEL`). NB: in this scale Exhibiting = **62.50**, not 75.
- **Banding cutoffs are the `grade_scaled` values.** So banding is *derived*, not a
  separate table: `pointsToLevel(n)` = "the highest level whose `grade_scaled ≤ n`,
  with IE as the floor." This one function correctly handles both an exact
  `grade_scaled` rollup (`62.50 → EX`) and a rounded 0–100 mean/mode (`80 → EX`).
  Used for mean **and** mode aggregation at topic and category granularity, and
  under `computeLetterGrade()`.

Both numeric scales must be owned by Prism: `points` for `/observations` writes,
`grade_scaled` for override writes.

## 3. The contract (levels-only)

- The MCP write tool `write_student_suggestions` accepts **levels only**:
  `rubric_scores` is `{ <topic external_id|title>: <level code|name> }`. Level
  names/codes are normalized to codes; anything out-of-vocabulary (including a
  numeric value) is **reported, never stored**, with an instructive message.
- Callers never supply a gradebook number. The optional per-student `score`
  (a caller-computed overall number) is **removed** from the contract.
- `get_assignment_context` returns levels, **never a bare proficiency-derived
  number** a caller could reverse-engineer.
- Teachers review and publish in proficiency terms. The numeric score that lands
  in Schoology is derived downstream by Prism from the single configurable scale.

## 4. Architecture

### 4.1 Config is the single source of truth — `config.yaml`

```yaml
grading:
  proficiencyScale:
    name: HKIS General Academic Scale
    schoologyScaleId: 21337256
    levels:                                   # ordered best → worst
      - { code: ED, label: Exhibiting Depth,      points: 100, gradeScaled: '87.50' }
      - { code: EX, label: Exhibiting,            points: 75,  gradeScaled: '62.50' }
      - { code: D,  label: Developing,            points: 50,  gradeScaled: '37.50' }
      - { code: EM, label: Emerging,              points: 25,  gradeScaled: '12.50' }
      - { code: IE, label: Insufficient Evidence, points: 0,   gradeScaled: '0.00'  }
```

`featureGate.js` gains `getProficiencyScale()` using the same default-merge
pattern as `getRubricConfig()` / `getSyncConfig()`, so the HKIS values are the
built-in default even when a config omits the block. Re-weightable per school
without code changes. Level **colors stay out of config** — they are theme, not
scale (see §9).

### 4.2 Server derivation module — `server/lib/proficiencyScale.js` (pure)

Reads the config table once; exposes every helper the codebase currently
re-implements:

| Helper | Behaviour |
|---|---|
| `LEVELS` | ordered codes `['ED','EX','D','EM','IE']` |
| `normalizeLevel(name\|code) → code\|null` | case-insensitive; numeric/unknown → `null` |
| `pointsToLevel(n) → code` | banding: highest level with `gradeScaled ≤ n`, IE floor |
| `levelToPoints(code) → number` | per-assignment observation scale |
| `levelToGradeScaled(code) → '62.50'` | Schoology override scale |
| `gradeScaledValues() → Set` | valid override values (replaces the magic list) |
| `levelToLabel(code) → string` | full label |
| `schoologyScaleId() → number` | replaces the hardcoded `21337256` |
| `getScaleTable() → [...]` | the full ordered array (feeds the endpoint + client) |

The DATA is single-source (config). The thin derivation helpers live where they
run; both sides read the one config-derived table — nothing hardcodes the level
table anymore.

### 4.3 Server→client sharing (mirrors the existing `/api/grading-scales` pattern)

- **Endpoint:** `GET /api/proficiency-scale` → `{ ...getScaleTable(), schoologyScaleId }`.
- **Client api:** `getProficiencyScale()` in `client/src/services/api.js`.
- **Client hook:** `useProficiencyScale()` (mirrors `useFeatureFlags`) — fetch + cache.
- **Client lib:** `client/src/lib/proficiencyScale.js` holds the pure display
  functions that take the fetched table — `pointsToLevel(table, n)`,
  `levelLabel(table, code)`, `levelToPoints(table, code)`,
  `levelToGradeScaled(table, code)`, `computeLetterGrade(table, levels)` — plus the
  single canonical `LEVEL_COLORS` (§9). Letter-grade logic stays client-only (the
  server never renders it) but now reads the shared table, so it can't drift.

## 5. Drift inventory — every copy collapses to the SSOT

Confirmed by sweep. Each row is deleted and repointed at the shared helper/table.

| Constant / fn | Current copies | Replacement |
|---|---|---|
| `LEVELS` (×9) | `rubricStore.js`, `rubricHash.js`, `mcp/handlers.js`, `OverridePopup`, `CompactRubric`, `MasteryPerformanceSummary`, `AssessmentSummaryPage`, `CoursePage`, `RubricDescriptorGrid.test` | `LEVELS` from the shared lib (server) / table (client) |
| `LEVEL_LABELS` / `GRADE_TO_LABEL` (×6) | `OverridePopup`, `MasteryPerformanceSummary`, `RubricDescriptorGrid`, `AssessmentSummaryPage`, `CoursePage`, `masterySync` | `levelToLabel` |
| `LEVEL_POINTS` (×3) + `POINTS_TO_GRADE` | `MasteryPerformanceSummary`, `AssessmentSummaryPage`, `CoursePage`, `masterySync` | `levelToPoints` / `pointsToLevel` |
| `LEVEL_COLORS` (×3, two shapes) | `OverridePopup`, `MasteryPerformanceSummary`, `AssessmentSummaryPage` (canonical) | single `LEVEL_COLORS` in shared client lib (§9) |
| level→`grade_scaled` (×3) | `OverridePopup.SCALED_FOR_LEVEL`, `mastery.js` magic list, schema comment | `levelToGradeScaled` / `gradeScaledValues` |
| `GRADING_SCALE_ID 21337256` (×2 prod) | `masterySync.js`, `AssessmentSummaryPage` | `schoologyScaleId()` |
| `pointsToLevel` (×2) | `CoursePage`, `MasteryPerformanceSummary` | shared client `pointsToLevel` |
| `computeLetterGrade` (×1, imported ×2) | `MasteryPerformanceSummary` (CoursePage imports it) | shared client `computeLetterGrade` |
| `normalizeLevel` `LEVEL_CODES` | `suggestions.js` | shared server `normalizeLevel` |

## 6. Write-path changes — enforce levels-only

- **`mcp/server.js`** — remove `score: z.number().optional()` from
  `write_student_suggestions`'s per-student schema (the caller-computed-number
  leak). Sharpen the `rubric_scores` description to "proficiency level code or
  name only — Prism owns the points conversion."
- **`server/services/suggestions.js`** — import `normalizeLevel` (delete local
  `LEVEL_CODES`). Stop accepting `score` (drop from destructure / params). When a
  `rubric_scores` value is numeric-looking, return the instructive note:
  *"Ignored numeric value for `<topic>` — emit proficiency levels; Prism owns the
  points conversion."* Non-fatal: the rest of the batch still writes. Keep the
  existing "report, never store" behaviour for all out-of-vocabulary values.

## 7. Read-path change — `get_assignment_context`

In `assessmentContext.js` `getAssessmentContext()`'s student mapping, project
`current_scores` to `{ <topic_id>: { level } }` — **drop the bare `points`** and
rename `grade` → `level` for vocabulary parity with the write side.

`getScoreMap()` stays `{ points, grade }`: the teacher-facing Express mastery grid
(`/api/mastery/...`) genuinely needs `points` to compute category averages. **Only
the MCP caller surface loses the number.** Document that callers must not infer or
replicate the mapping from any number they see.

## 8. Schoology write paths — both via the SSOT

- **Per-assignment `/observations`** (`AssessmentSummaryPage.buildGradeInfo`): use
  `levelToPoints(level)` and `schoologyScaleId()` from the shared lib instead of
  hardcoded `LEVEL_POINTS` / `21337256`. (The client still performs the
  conversion; routing it server-side is a noted follow-up, not in this scope —
  the external-caller problem is fully solved without it.)
- **Per-objective override** (`OverridePopup` → `POST /api/mastery/:courseId/override`
  → `writeMasteryOverride`): the route accepts a **level** and derives
  `grade_scaled` via `levelToGradeScaled`; validation uses `gradeScaledValues()`.
  `OverridePopup` sends `level`, dropping `SCALED_FOR_LEVEL`. (Back-compat: the
  route may still accept a raw `gradeScaled` validated against `gradeScaledValues()`
  during transition.)

## 9. Colors — canonical palette

The canonical 5-level palette is **`AssessmentSummaryPage`'s** (the richest):

```js
LEVEL_COLORS = {
  ED: { headerFill: '#bfdbfe', draftFill: '#eff6ff', finalBorder: '#2563eb', draftBorder: '#93c5fd' },
  EX: { headerFill: '#bbf7d0', draftFill: '#f0fdf4', finalBorder: '#16a34a', draftBorder: '#86efac' },
  D:  { headerFill: '#fef08a', draftFill: '#fefce8', finalBorder: '#ca8a04', draftBorder: '#fcd34d' },
  EM: { headerFill: '#fed7aa', draftFill: '#fff7ed', finalBorder: '#ea580c', draftBorder: '#fdba74' },
  IE: { headerFill: '#fecaca', draftFill: '#fef2f2', finalBorder: '#dc2626', draftBorder: '#fca5a5' },
}
CELL_TEXT = '#1a1a1a'
```

This lives as the single `LEVEL_COLORS` in `client/src/lib/proficiencyScale.js`.
All level-colored surfaces import it — **student profile (`StudentPage`), course
overall-mastery view + gradebook (`CoursePage`, `MasteryPerformanceSummary`),
override modal (`OverridePopup`), and `AssessmentSummaryPage`** — so they all match.

Field mapping for consumers currently on `{bg, text, border}`: `bg → headerFill`,
`text → CELL_TEXT`, `border → finalBorder` (or `draftBorder` for draft/unsaved
cells). **Intended visual consequence:** level cells move to the single dark
`CELL_TEXT` instead of per-level text colors — the deliberate unification.

**Documentation home:** the color decision is recorded in
`docs/design-language.md` (it already has a "Level headers — full wording,
colour-coded" entry and a "Source of truth" section), pointing at the shared lib
as the canonical source. **Deferred follow-up:** migrate these hex values to CSS
custom properties (`--level-ed-header`, …) per the repo theming rule so
theme-switching applies; tracked, not done here.

## 10. Documentation changes

- **New ADR** (`docs/adr/` — created here as the first entry): "Prism owns the
  proficiency↔gradebook-score mapping; the write contract is levels-only." Records
  the three-scale reality and the single-source decision.
- **`CONTEXT.md`** — add proficiency vocabulary (the five levels + codes) and the
  contract sentence to the ubiquitous-language section.
- **`docs/design-language.md`** — the level-color decision (§9).
- **`README.md`** — state the levels-only contract in the standards-based-grading note.
- **`product-spec.md`** — fix the stale `rubric_scores: { criterion_name: "number" }`
  (it currently advertises numbers — actively misleading).
- **Dovetail spec** (`docs/superpowers/specs/2026-06-06-prismcp-server.md`) — update
  the `get_assignment_context` / `write_student_suggestions` shapes to levels-only.

## 11. Testing

- **Parity test** (verification-of-choice per build notes): assert the
  config-derived maps equal today's hardcoded ones — `pointsToLevel`,
  `levelToPoints`, `levelToLabel`, `levelToGradeScaled`, `schoologyScaleId` — so the
  refactor provably preserves behaviour.
- **`proficiencyScale` unit tests** — banding edges (`12.49`→IE vs `12.50`→EM,
  `62.50`→EX, `87.49`→EX vs `87.50`→ED); `normalizeLevel` accepts names + codes
  case-insensitively and rejects numerics/unknowns; config default-merge applies
  when the block is absent.
- **`suggestions` test** — caller `score` is ignored (not written to
  `feedback.score`); numeric `rubric_scores` value yields the instructive message;
  valid levels still write; rest-of-batch unaffected.
- **`assessmentContext` test** — `current_scores` exposes `level` and **no**
  `points`; Express mastery grid still receives `points`.
- **override-route test** — deriving `grade_scaled` from a level; rejecting an
  out-of-scale value via `gradeScaledValues()`.
- **client tests** — updated for the shared lib (`pointsToLevel` /
  `computeLetterGrade` / `LEVEL_COLORS` moved); `useProficiencyScale` fetch/caching.

## 12. Out of scope / follow-ups

- Moving the per-`/observations` level→points conversion server-side (client still
  converts via the shared lib for now).
- Migrating level colors to CSS custom properties for theme support.
- Per-course scales (the school has one scale today; config is per-school).

## 13. Risks & mitigations

- **Behaviour drift during the refactor** → the parity test pins old==new before
  any deletion; refactor each call site to the shared helper, re-run parity.
- **Visual regression from the color unification** → intended per the explicit
  request; captured in design-language.md; reviewable on the three named surfaces.
- **Client/server scale skew** (two files derive from one config) → the config
  table is the only source; the client fetches the server's derived table rather
  than re-declaring it, and the parity test covers the server helpers.
- **Override route contract change** → optional transitional acceptance of a raw
  `gradeScaled` validated against `gradeScaledValues()` avoids a flag-day break.
