# ADR 0002 — PII handling: surface teacher-accessible data; the LLM intermediary is a consideration, not a blocker

**Status:** Accepted (2026-06-11)
**Supersedes:** the "human-implemented, feature-flagged, possibly display-only / no-persistence, treat sensitivity as a near-blocker" framing in the working notes of #65 and #68 and in earlier api-reference caveats.

## Context

Prism surfaces PowerSchool/Schoology data the teacher is **already authorized to see** for their own students: grade level, attendance, on-track / enrollment, guardian "do-not-contact" / deceased flags, and SEN / accommodation data (Accommodation Plan / SPP, Individual Learning Plan, Learning Support Level, allergies / medical, MAP scores).

Earlier notes treated the sensitive tiers as a near-blocker — gated behind "needs a privacy decision," "human-implemented only," "maybe display-only / no DB persistence." In practice this stalls features that re-present, in a better UI, data the teacher already reads daily in PowerSchool and Schoology.

Prism is **local-first** and **single-teacher**. Its value is showing data the teacher already has access to, better and in-context — e.g. seeing a student's accommodations (and extra-time amount) while setting up a test, rather than tab-hopping into PowerSchool.

## Decision

1. **Prism may capture, store locally, and display PII the teacher is already authorized to see for their own students.** Re-presenting authorized data in a better UI is not a new disclosure.
2. This explicitly covers SEN / accommodation, attendance, on-track / enrollment, and guardian-contact flags **for the teacher's own roster**.
3. **The LLM / MCP intermediary** (PII flowing to a model via Prism's MCP tools) is a real consideration to handle **deliberately** — but it is **not a blocker** to building these features. Be intentional about what is sent to the model and when; prefer a presence-flag or short summary over dumping raw sensitive detail where a flag serves the task.

## Guardrails that remain (unchanged)

- **Local-first** — student data lives in the local SQLite DB on the teacher's machine; never committed to git; not sent to third parties beyond the model the teacher is already invoking.
- **Teacher-scoped** — only the teacher's own students.
- **Exploration hygiene** — probes and logs mask values; raw dumps stay in `/tmp` and are deleted when done (see `.claude/api-exploration-playbook.md`).
- **Especially-sensitive categories** (SEN / medical / MAP) — display in-context for the teacher's own students; gate behind a feature flag; avoid bulk export; when an LLM/MCP path is involved, prefer flags/summaries over full raw detail unless the task needs it.

## Consequences

- Features touching teacher-accessible PII (e.g. accommodations surfacing) proceed as **normal feature work**, feature-flagged — not blocked pending a separate privacy ruling.
- #65 (scope additional PowerSchool data points) and #68 (postal address) lose their "treat as blocker" framing; their *implementation* slices can be built under these guardrails.
- New work cites this ADR for its PII stance rather than re-litigating the policy per issue.
