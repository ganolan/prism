# Sync perf — make full sync feel snappy without losing fidelity

**Issue:** #55 (Perf: sync wall time dominated by per-(assignment, student) submission-status calls)
**Status:** Approved design — ready for implementation plan
**Related context:** #49 (introduced the submission-status sync), #54 (added small per-write overhead via assignee writes)

## Problem

A full sync currently takes ~3.5 minutes, dominated by Schoology's per-(assignment, student) submission-status endpoint. The previous in-conversation attempt to fix this (concurrency=8 + `Retry-After`-honoring backoff) produced rate-limit cascades and multi-minute silent stalls and was rolled back.

Two costs compound:

1. **API latency, N×M.** `GET /sections/{id}/submissions/{aid}/{uid}` is called once per (dropbox assignment × enrolled student) and run fully sequentially. Schoology has no bulk submissions endpoint on the public REST API. For a heavy section that's ~120 calls × ~200ms = ~24s; total sync sits at ~3.5min.
2. **OneDrive fsync per row.** The DB lives on a OneDrive-synced path. Each autocommit write costs ~50ms of fsync. The sync writes one row per cell, so the per-row cost compounds on top of API latency. The DB-write commits added by #54 (assignee writes) layer another ~10-15s on top.

The user requires:
- **Full coverage every sync.** Schoology is the single source of truth; Prism must reflect the freshest state of every dropbox assignment after a sync. Scope-reduction (e.g., "skip assignments older than 30 days") and lazy/on-demand sync are off the table.
- **Target wall time: under ~30s.** "Threshold where I stop dreading the sync."
- **No mixed-staleness within a logical unit.** If part of a sync fails, the surviving DB state must be internally consistent at the unit the UI surfaces — never some students fresh and others stale within the same assignment.

## Out of scope

- Internal Drupal API spike to find a bulk-submissions endpoint. (Filed as a follow-up if Approach 1 doesn't reach <30s.)
- Cross-section parallelism. Sections continue to sync one at a time.
- Backfill of submission state for sections excluded by archival or hidden flags.
- Scope-reduction (older assignments). Explicitly rejected by the user.
- Lazy/background sync. Explicitly rejected by the user.

## Approach

Two compounding fixes inside `syncSectionData`, plus a small `apiGet` change, plus a new in-process rate-limited concurrency runner.

### A. Transactional writes per section, in phases

Replace the current interleaved "fetch → write → fetch → write" flow with phased work:

1. Fetch enrollments → write all in one `db.transaction()` block (one fsync).
2. Fetch assignments + parse assignees → write all (assignments + `assignment_assignees`) in one transaction.
3. Fetch grades → write all in one transaction.
4. Fetch all submission statuses (the hot loop, parallel — see B below) → commit accepted results in one transaction at the end of the section.

Trade-off: a fetch failure in phase N rolls back phase N's writes but leaves phases 1..N-1 persisted. That is a behavior change from today's partial-writes-on-error semantics, and a deliberate improvement: a half-failed sync now leaves a coherent (older) snapshot for the failing phase rather than mixed-age data.

Expected impact alone: ~10-15s shaved off total wall time by collapsing OneDrive fsyncs from "per row" to "per phase per section." This piece is pure win and ships first.

### B. Rate-limited, concurrency-capped submission loop with per-assignment atomicity

Replace the current serial nested loop with:

1. Build the work list for the section as `{ assignment, student }` pairs across all dropbox assignments.
2. A bounded-concurrency runner (`concurrency=N` from config, starting at 2) consumes the list.
3. A global token bucket (`rate=R/sec` from config, starting at 4) wraps every `getSubmissionStatus` call across the whole sync run. Schoology rate-limits per-account, so the bucket is global — *not* per-section.
4. Results stream into a per-assignment buffer.
5. **Per-assignment atomicity:** when all of an assignment's cells have returned, if every one succeeded, queue that assignment's writes for the end-of-section transaction. If **any** cell returned a transient failure — 429, any 5xx, or a network error (`fetch` rejection / DNS / TLS) — discard the assignment's in-memory results, add the assignment id to `failedAssignments[]`, and continue with the next assignment. Other 4xx responses (401, 403, 404…) propagate as fatal errors and abort the sync: those indicate a real bug or auth problem, not transient pressure.
6. After the section's main pass completes, commit the queued writes in one transaction.

#### Atomicity rationale

An assignment is the consistency unit the UI surfaces — the gradebook column and the assessment roster show one assignment's students together. Per-assignment atomicity guarantees no row within a column has stale data while another row has fresh data. Section-level atomicity (throwing away everything in the section on one 429) was rejected as too wasteful; cell-level atomicity was rejected as mixed-staleness within the unit the user reads.

#### End-of-sync retry pass

After all sections complete their main passes, if `failedAssignments` is non-empty, run a single retry pass:

- Concurrency = 1 (sequential), no token bucket needed (one in-flight request cannot bust any rate limit).
- Each previously-failed assignment is fully re-fetched and written atomically.
- If the retry succeeds, the assignment's `sync_metrics.retries_succeeded` count increments and the result lands silently.
- If the retry **also** 429s, the assignment id is recorded in `sync_metrics`, no rows are written for it, and the previous-sync values for those students on that assignment remain intact.
- One pass only. No further retries. No `sleep` or `Retry-After` honoring anywhere in the system.

The retry pass uses elapsed wall time of the other sections' work as its implicit cool-down — *not* a blocking sleep. This is the critical difference from the previous attempt.

#### Abandonment threshold

A `submissionAbandonAfter` config knob (default 5) caps the size of `failedAssignments`. If the main pass crosses that threshold, the rest of the run skips submission-status fetching entirely (other phases still run normally) and the retry pass is skipped. The user sees a clear banner: "Submission sync abandoned due to repeated rate limits — re-run sync later." Prevents thrashing on a Schoology-side incident.

### C. `apiGet` transient-error tagging

`server/services/schoology.js` currently throws `Schoology API ${status}: GET ${path}` on any non-2xx. Tag the transient ones so the submission worker can distinguish them:

```js
if (!res.ok) {
  const err = new Error(`Schoology API ${res.status}: GET ${path}`);
  if (res.status === 429) err.rateLimited = true;
  if (res.status >= 500 || res.status === 429) err.transient = true;
  throw err;
}
```

Network-level rejections from `fetch` (DNS / TLS / socket reset) propagate as native errors; the submission worker treats *any* thrown error in a submission cell as transient for atomicity purposes — except errors tagged with explicit non-transient status codes (handled by re-throwing at the top of the worker's catch). Fatal 4xx (401/403/404/etc) propagate unchanged and abort the sync, preserving existing fail-loud behavior for genuine bugs.

## Config

New keys in `config.yaml`:

```yaml
sync:
  submissionConcurrency: 2     # main-pass in-flight submission calls
  submissionRatePerSec: 4      # global token-bucket refill rate
  submissionAbandonAfter: 5    # main-pass 429 threshold; skips retry & remaining submissions
```

The retry pass is hardcoded to concurrency=1 and bypasses the token bucket. It is not user-configurable.

Defaults are deliberately conservative — well below the concurrency=8 that broke the previous attempt. Tuning is empirical: run sync, inspect `sync_metrics`, and raise `submissionConcurrency` (then `submissionRatePerSec`) until 429s reliably appear, then back off one step. The final values committed to `config.yaml` are the empirically-verified safe ceiling.

## Observability

New table `sync_metrics`, one row per sync run:

| Column | Notes |
|---|---|
| `id` INTEGER PRIMARY KEY | |
| `sync_log_id` INTEGER | FK to `sync_log` |
| `started_at` TEXT | ISO timestamp |
| `duration_ms` INTEGER | Wall-time for the whole run |
| `submission_calls` INTEGER | Total submission HTTP calls (main + retry) |
| `rate_limit_hits` INTEGER | Total 429 responses |
| `transient_failures` INTEGER | 5xx + network errors (separate from 429s for diagnosis) |
| `retries_attempted` INTEGER | Size of `failedAssignments` at retry start |
| `retries_succeeded` INTEGER | Of the retried, how many succeeded |
| `retries_failed` INTEGER | Of the retried, how many 429'd again |
| `concurrency` INTEGER | Effective `submissionConcurrency` for this run |
| `rate_per_sec` INTEGER | Effective `submissionRatePerSec` for this run |
| `abandoned` INTEGER | 0 or 1 — did the run trip `submissionAbandonAfter` |

Also: structured console output per section and per run, e.g.

```
[sync] section "AP CSP — 2": enrollments=12 assignments=34 dropbox=10
       submission: 120 calls, 0 429s, 8.4s @ effective 14 req/s
[sync] retry pass: 0 assignments to retry, skipped
[sync] total: 9 sections, 612 submission calls, 2 429s, 38.2s
```

`SyncDialog` (or `SyncProgress`) gains a banner that surfaces:
- `retries_failed > 0` → "N assignments couldn't sync — re-run when ready"
- `abandoned = 1` → "Submission sync abandoned due to repeated rate limits — re-run sync later"

## Error handling matrix

| Failure | DB state | sync_log entry | UI signal |
|---|---|---|---|
| Section enrollment/assignment/grade fetch 4xx/5xx | Phase tx rolled back; previous data intact | `sync_log` `failed` row for section | Sync modal per-section error |
| Submission cell 429 in main pass | In-memory only; nothing written for that assignment | `sync_metrics.rate_limit_hits++` | None yet — retry handles |
| Retry pass succeeds | Atomic per-assignment write | `sync_metrics.retries_succeeded++` | Recovered silently |
| Retry pass 429s again | Previous-sync values retained for those students | `sync_metrics` records assignment id | Banner: "N assignments couldn't sync — re-run when ready" |
| `submissionAbandonAfter` tripped | Retry skipped; rest of submissions skipped | `sync_log` row notes abandonment | Banner: "Submission sync abandoned — re-run sync later" |
| 5xx or network error on a submission cell | Same as 429 for that assignment | `sync_metrics.transient_failures++` | Same retry-pass path as 429s; banner if retry also fails |
| 4xx other than 429 (401/403/404…) | Sync aborts; no submission writes for this run | `sync_log` `failed` row with status code | Modal shows fatal error |

The user always sees *which* assignments are stale, by name, in the sync modal. No silent staleness.

## Testing

Three unit-level layers, all mock-based (no live Schoology):

1. **Rate-limited concurrency runner** (`server/services/rateLimitedRunner.test.js`, new). With `vi.useFakeTimers()`:
   - Concurrency cap respected (never more than N in-flight).
   - Rate cap respected (never more than R/sec over a window).
   - 429 errors propagate to caller; other errors propagate to caller.
   - Results delivered in submission order.

2. **Submission phase** (extends `server/services/sync.test.js`):
   - Per-assignment atomicity: one cell in assignment X 429s → zero rows for X written, other assignments' rows present.
   - Retry pass: failed assignment retried serially → if succeeds, rows present; if 429s again, recorded in metrics and no rows written.
   - `submissionAbandonAfter` trips at threshold → remaining sections' submission phases skipped, other phases still run.

3. **Transactional write phases** (also `sync.test.js`):
   - Each phase commits atomically (e.g., spy `db.transaction()` calls, or inspect DB state at known checkpoints).
   - Failed fetch in phase N leaves phases 1..N-1 intact but writes nothing for phase N.

Estimated new tests: ~12-15. Existing 61 tests remain green.

## Files touched

- `server/services/sync.js` — rewrite of `syncSectionData` (phased transactions + new submission-phase loop + retry pass).
- `server/services/rateLimitedRunner.js` — new, ~60 lines.
- `server/services/schoology.js` — `apiGet` 429 detection branch.
- `server/db/schema.sql` + `server/db/index.js` — `sync_metrics` table.
- `config.yaml` — new `sync.*` keys.
- `server/routes/schoology.js` — expose latest `sync_metrics` so UI can render the banner.
- `client/src/components/SyncDialog.jsx` (or `SyncProgress.jsx`) — banner for retry failures and abandonment.
- Tests as above.

## Rollout plan

Three commits / PRs:

1. **Transactional writes (low risk).** Phase the existing fetches into per-phase transactions. Zero behavior change beyond commit boundaries; sync should be ~10-15s faster on OneDrive immediately. Ship this first to lock in the easy win.
2. **Concurrent submission loop + rate limiter.** Adds `rateLimitedRunner`, refactors submission phase to per-assignment atomicity, exposes `concurrency=2 / rate=4` defaults. No retry pass yet; the abandonment threshold gates safety.
3. **Retry pass + metrics + UI banner.** Adds the end-of-sync retry, `sync_metrics` table, and banner. Empirical-tuning loop begins.

Splitting like this gives a clean rollback boundary if any step misbehaves on real Schoology data.

## Success criteria

- A full sync against the real Schoology account completes in under ~30s on the user's typical workload (target B from the brainstorm).
- Zero mixed-staleness incidents: any row in the DB with `synced_at = <this run's timestamp>` reflects fresh Schoology data; any row with an older `synced_at` is from a prior successful sync.
- 429s, when they occur, are visible in `sync_metrics` and surface to the user via the sync modal — never silent.
- No `sleep`, `setTimeout(..., retryAfter)`, or any other blocking wait on Schoology's `Retry-After` header anywhere in the system.
