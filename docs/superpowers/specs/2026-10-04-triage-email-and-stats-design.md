# Triage: email students from each panel, plus a Dashboard stats strip (#137)

Date: 2026-10-04. Status: design approved in brainstorm, awaiting spec review.

## Goal

Email the right students about the right triage issue without typing addresses or
working out who needs what, and see "how behind am I?" at a glance on the Dashboard.

Success: one tap in a triage panel puts a deduplicated, Outlook-ready address list on
the clipboard; each row can open a prefilled email to that one student; the Dashboard
shows four overdue counts that match the panels and jump to them.

## Scope

In:

1. An `@ ▾` menu in the header of the Make-up tests, Late work and Resubmissions panels
   that copies student addresses.
2. A ✉ `mailto:` link on every row of those three panels.
3. A stats strip on the Dashboard's Current tab: one status line + four tiles.

Out (decided 2026-10-04):

- Full-width triage board with filter chips / checkboxes, and Dashboard tabs
  (Overview / Courses): later, only if the per-panel menu proves too coarse.
- Parent addresses: not now. When added, source them from the `parents` table
  (397 of 416 rows have an email in prod), not `students.parent_email` (106 of 212).
- Median feedback turnaround, waiting totals, oldest wait: not in the first strip.
  Turnaround would need a new "grade first seen" timestamp and starts empty.
- Feedback owed panel gets no email menu (it is the teacher's backlog, not the students').

## Facts this relies on

- Every student in prod has `students.email` (212 of 212, checked read-only 2026-10-04).
- Outlook (desktop and web) accepts `a@hkis.edu.hk; b@hkis.edu.hk` in To / Bcc.
- Triage scope comes from the page: all current courses on the Dashboard, one course on
  a course page. No subject filter is needed.
- `getTriage` already returns `counts.{atReferralLimit, makeUpsOverdue,
  resubmissionsOverdue, feedbackOverdue}` (red-tone counts per list).
- `useSchoologyConnection()` reads `GET /api/mastery/login-status`: one cheap
  authenticated check on the server, cached ~10 minutes.
- Prism has no toast system; the clipboard is used ad hoc (Student page, Tools page).

## 1. Server: `studentEmail` on triage rows

Add `studentEmail` (from `students.email`, `null` when missing) to every row of
`lateWork`, `makeUps` and `resubmissions` in the triage payload. Row-building sites:
`server/services/triage.js` (late work + make-ups) and
`server/services/resubmissions.js` (resubmission rows). `feedbackOwed` rows are
per assessment and get nothing.

The MCP `get_triage` tool returns the same payload, so the agent gains the addresses
too; that partly serves #119 and needs no extra tool work. The repo is public, but
emails only ever live in the DB and API responses, never in committed files or fixtures
(tests use made-up `@example.test` addresses).

## 2. Client logic: `client/src/lib/emailLists.js` (pure)

- `stillOwing(kind, row)`:
  - `makeUps`: every row.
  - `late`: every row except `kind === 'submitted_late'`.
  - `resubmissions`: every row except `state === 'arrived'`.
- `buildEmailMenu(kind, rows, { showCourse })` returns
  `{ tiers: [{ label, students, emails }], byAssessment: [{ label, students, emails }] }`
  built from the still-owing rows only. Counts are distinct students.
  - Tiers: `Red (n)`, `Red + amber (n)`, `Everyone still owing (n)`. A tier is dropped
    when its count equals the tier before it (no "Red (3) / Red + amber (3)"), and when
    it is 0.
  - By assessment: one item per `assignmentId`, label = title, plus ` · BK n` when
    `showCourse` and the row has a block (two AP CSP sections can share a title).
    Sorted by count descending, then title.
- `formatAddresses(emails)`: drop empty values, dedupe case-insensitively (keep the
  first spelling, keep list order), join with `'; '`.
- `mailtoFor(row, kind)`: `mailto:<email>?subject=<encoded>`, subject
  `<course name>: <title>, <late work | make-up test | resubmission>`. The course name is
  the short name `courseLabel` already uses, without the `[BK n]` prefix. Returns `null`
  when the row has no email.

## 3. `client/src/components/triage/EmailMenu.jsx`

- Rendered in `PanelHead`'s actions beside `ShowAllToggle` by the three panels.
- Button: `@ ▾`, `.ghost.accent` (same size as "All N ▾"), `aria-label` and `title`
  "Copy student emails", `aria-haspopup="menu"`, `aria-expanded`. Hidden when no row is
  still owing.
- Menu: a small popover listing the tiers, then a "By assessment" group. Closes on item
  choice, outside click, or Escape.
- Choosing an item: `navigator.clipboard.writeText(formatAddresses(...))`. If the
  clipboard API is missing or rejects, show the address string in a read-only,
  pre-selected text field in the panel so it can be copied by hand.
- Confirmation: an inline `role="status"` line inside the panel:
  "5 addresses copied. Paste into Outlook To or Bcc." Adds " 1 student has no email in
  Prism." when any chosen row lacked one. Clears after ~5 seconds.
- Copy uses hyphens, commas or colons, never em dashes.

Row link: each row of the three panels gets a small ✉ link (`<a href={mailtoFor(...)}>`,
`aria-label` "Email {studentName}") on every row, including arrived and submitted-late
rows. No link when the row has no email.

## 4. Dashboard stats strip

On the Current tab only, above `.triage-layout` (course cards + rail). Not on the
Archived tab or course pages.

Status line (`.text-sm.text-muted`), replacing the header's school-day text and the
separate "Last sync" paragraph:

> School day 34 of 172 · Day C · Last sync 04/10/2026 07:12, success · Schoology: connected

- School day / cycle from `triage.calendar` (as today); last sync from `getSyncStatus()`
  (as today), formatted with `formatDateTime`.
- "Schoology: connected | expired | unknown | not set up" from `useSchoologyConnection()`.
  Expired links to Settings (Schoology connection card). Parts with no data are omitted.

Tiles (four `<button>`s), from `triage.counts`:

| Tile | Count | Scrolls to panel id |
|---|---|---|
| At referral limit | `atReferralLimit` | `triage-late` |
| Make-ups overdue | `makeUpsOverdue` | `triage-makeups` |
| Resubmissions overdue | `resubmissionsOverdue` | `triage-resubmissions` |
| Feedback overdue | `feedbackOverdue` | `triage-feedback` |

- Big number + label. Red tone (CSS variables) when the count is above 0; muted "0"
  when clear.
- Click: `scrollIntoView` on the panel and focus its heading (the heading gets
  `tabIndex={-1}`). The four panels get those stable ids.
- Data: the triage payload the Dashboard already receives via `TriageSection`'s
  `onLoaded`; no new fetch. Before triage loads, only the status line shows.
- Layout: four in a row on desktop; 2×2 grid inside the existing `PHONE LAYOUT` block
  at the end of `client/src/app.css`.

## Testing

- Server: `triage.test.js` (and the resubmissions tests) assert `studentEmail` on
  late, make-up and resubmission rows, `null` when the student has no email.
- `emailLists.test.js`: still-owing filter per kind, tier counts as distinct students,
  equal-count and zero tiers dropped, by-assessment labels with and without block,
  case-insensitive dedupe, missing emails dropped, `mailtoFor` subject + encoding.
- `EmailMenu.test.jsx` (RTL): hidden when nobody still owes; menu items and counts;
  copy calls a mocked `navigator.clipboard.writeText` with the `; `-joined string;
  status message (and the missing-email clause); Escape closes; fallback field when the
  clipboard rejects.
- Panel tests: ✉ link `href` per row, absent without an email.
- `Dashboard.test.jsx`: tile counts and tones from `counts`; click calls
  `scrollIntoView` on the right panel; status line parts; expired links to Settings.
- Phone: `npm run check:mobile http://127.0.0.1:3002` against a dev server on a /tmp
  DB copy, plus rendered screenshots of the strip and an open `@` menu.

## Docs

- Append a `docs/design-language.md` entry: `@` = copy addresses vs ✉ = compose
  (`mailto:`), the inline status line instead of a toast, the stats strip tiles.
- Note the feature in `.claude/build-progress.md` (Triage section).
