# ADR 0001: Prism owns the proficiency↔gradebook-score mapping

**Status:** Accepted (2026-06-09)

## Context

Grading callers (the `assessment-grader` Claude Code plugin, an MCP caller) emit
per-measurement-topic **proficiency levels** only — `ED / EX / D / EM / IE`
(Exhibiting Depth → Insufficient Evidence). They never compute or supply gradebook
points.

In a real grading run, the AI grader **reverse-engineered** the level→points scale
(`ED=100 / EX=75 / D=50 / EM=25 / IE=0`) by inspecting two already-graded students'
numeric scores, because Prism exposed bare numbers and the mapping was not cleanly
owned on the Prism side.

The same five levels have **three** numeric encodings, verified against the code:

| Level | `points` (per-assignment observation; `mastery_scores`, `/observations` write) | `grade_scaled` (per-objective rollup/override; Schoology UI + override write) | banding cutoff |
|---|---|---|---|
| ED | 100 | 87.50 | ≥ 87.5 |
| EX | 75  | 62.50 | ≥ 62.5 |
| D  | 50  | 37.50 | ≥ 37.5 |
| EM | 25  | 12.50 | ≥ 12.5 |
| IE | 0   | 0.00  | < 12.5 |

The banding cutoffs ARE the `grade_scaled` values, so `pointsToLevel` derives from
the table: "the highest level whose `gradeScaled ≤ n`, with IE as the floor."

## Decision

The numeric mapping is owned by Prism and configured **once** in `config.yaml`
under `grading.proficiencyScale` (per school / scale; re-weightable without code).
It is derived through a single module on each side:

- **Server:** `server/lib/proficiencyScale.js` — consumed by `suggestions`,
  `masterySync`, the mastery override route, the rubric stores, and the MCP handlers.
- **Client:** `client/src/lib/masteryLevels.js` + the `useProficiencyScale()` hook,
  fed by `GET /api/proficiency-scale`.

The MCP write contract is **levels-only**:

- `write_student_suggestions` accepts level codes/names only; a numeric value is
  reported, never stored ("emit proficiency levels; Prism owns the points
  conversion"). The former caller-supplied overall `score` is removed.
- `get_assignment_context` returns `current_scores: { <topic_id>: { level } }` —
  never a bare `points` number a caller could reverse-engineer from.

Both Schoology write paths apply the scale internally: the per-assignment
`/observations` write uses `levelToPoints` + `schoologyScaleId`; the per-objective
override uses `levelToGradeScaled`.

**Boundary:** config owns the *numeric* mapping (points / gradeScaled /
schoologyScaleId — the part that leaked and that schools re-weight). Level
*identity* (codes, labels, order, colors) is stable and lives as constants in the
two SSOT modules.

## Consequences

- A teacher re-weights the scale by editing config, not code.
- Neither the AI caller nor the teacher ever sees, supplies, or infers a gradebook
  number — they speak proficiency.
- ~8 previously-scattered hardcoded copies (`LEVELS`, `LEVEL_POINTS`,
  `LEVEL_COLORS`, `POINTS_TO_GRADE`, `SCALED_FOR_LEVEL`, `GRADING_SCALE_ID`, plus two
  `pointsToLevel` / `computeLetterGrade` copies) were consolidated onto the SSOT; a
  parity test pins the derived values to the former hardcoded ones.
- Level colors were unified on the canonical `AssessmentSummaryPage` palette (see
  `docs/design-language.md`).

## References

- Spec: `docs/superpowers/specs/2026-06-09-proficiency-scale-ownership-design.md`
- Plan: `docs/superpowers/plans/2026-06-09-proficiency-scale-ownership.md`
