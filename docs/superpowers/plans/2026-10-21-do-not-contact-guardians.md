# Do-not-contact guardians (#66) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every sync, map each Prism parent to PowerSchool's Guardian 1 or 2, apply PowerSchool's do-not-contact and deceased flags, and keep every guardian Prism cannot clear out of every copy and out of sight on a projected page.

**Architecture:** The #117 alert sync (`psAlertsSync.js`) gains one page read per section, the PowerTeacher Emergency Contact List, parsed into per-student slots and stored in a new table. A pure decision module calculates each parent's status at read time from the stored slots, the stored flags and the current `parents` rows. The student and Class Tools routes attach or apply the status; the student page hides flagged guardians behind the existing **Show alerts** reveal.

**Tech Stack:** Node ESM, Express, better-sqlite3, Vitest; React 18 + React Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-21-do-not-contact-guardians-design.md` (read it first; this plan does not repeat its reasoning).

## Global Constraints

- Plain HTTP only, no browser; at most one `home.html` + one `StudEmgContacts.html` GET per section per sync, on the session the alert sync already starts.
- A "Security Violation Logged" page throws `PS_SECURITY` and stops the sync (as every PowerSchool read does today).
- Prism changes stored guardian data only on a successful read; a failed read keeps last-known rows.
- With `getFeatures().powerschool_alerts` false, every route and page behaves exactly as today (no `contact` field, nothing filtered).
- Fixtures hold no real names, emails or phone numbers. Probes and parity scripts print counts and shapes only.
- UI copy: no em dash and no en dash (a guard test enforces it); dates through `formatDate` (`client/src/lib/formatDate.js`, DD/MM/YYYY); colours only from `client/src/app.css` custom properties; phone rules only in the `PHONE LAYOUT` block.
- New columns go in both `server/db/schema.sql` and the `MIGRATIONS` array in `server/db/index.js`.
- Status values (exact strings): `not_checked`, `not_matched`, `do_not_contact`, `deceased`, `contactable`.
- Reason copy (exact): `do_not_contact` "Do not contact (PowerSchool)"; `deceased` "Deceased (PowerSchool)"; `not_matched` "Not matched to a PowerSchool guardian"; `not_checked` "Not checked against PowerSchool yet". Primary label: "Primary contact". Copy all note: "{N} not copied". Class Tools note: "{N} guardians not copied" ("1 guardian not copied" for one).

## Review Focus

1. **A sibling flagged on one child's record only:** the guardian is left out for both children, on both student pages and in Class Tools across both courses (Task 3 test `a flag for one child applies to a sibling with the same uid or email`; Task 4 test `Class Tools leaves out a guardian flagged through a sibling`).
2. **A Schoology parent added after the last PowerSchool read:** `not_matched`, never `contactable` (Task 3 test `a parent with no slot is not_matched`).
3. **The Emergency Contact List markup changes (a renamed or missing column):** the parser throws, the section keeps last-known guardians, and alerts still store (Task 1 test `a header without G2 Email throws`; Task 2 test `a list that fails keeps last-known guardians and still stores alerts`).
4. **Two students in one section with the same `lastfirst`:** neither is stored from that list (Task 1 test `duplicate roster names join neither`).
5. **The only synced parent is deceased:** the page shows no card and no "No parent/guardian contacts synced yet" message until the reveal (Task 5 test `a lone deceased parent shows neither a card nor the not-synced message`).

---

### Task 1: Read and parse the Emergency Contact List

**Files:**
- Modify: `server/services/powerschoolWeb.js` (new method)
- Create: `server/lib/psEmergencyContacts.js`, `server/lib/psEmergencyContacts.test.js`
- Modify: `server/testing/fakePowerSchoolWeb.js` (serve `/teachers/home.html` and `/teachers/StudEmgContacts.html`)
- Test: `server/services/psAlertsSync.test.js` (the `PowerSchoolWeb` describe block)

**Interfaces:**
- Produces: `PowerSchoolWeb#teacherPage(path: string, { referer?: string }) → Promise<string>`: a GET with `Accept: text/html`, the session cookie, `Referer: ${PS_BASE}${referer}` when given, no `X-Requested-With`, `redirect: 'manual'`. Security-violation text → `PS_SECURITY`; 3xx → `PS_SESSION` with `sessionEnded: true`; other non-200 → `PS_SESSION` with `sessionEnded: false`.
- Produces: `parseEmergencyContacts(html: string) → Array<{ student: string, g1: { name, email }, g2: { name, email } }>` (strings trimmed, HTML entities decoded, an email cell's first address lower-cased, empty → `null`). Finds the table by header text `Student`, `Guardian 1`, `G1 Email`, `Guardian 2`, `G2 Email` (any order, other columns ignored); throws `Error('emergency contact list: header not found')` otherwise.
- Produces: `slotsByDcid(rows, roster: [{ lastfirst, studentdcid }]) → Map<string dcid, { g1, g2 }>`: joins `row.student` to `roster.lastfirst` (trimmed, case-insensitive, runs of spaces collapsed); a `lastfirst` held by two roster students joins neither.
- Fake: `fakePowerSchoolWeb({ emergency: { [sectionDcid]: html | { status } } })` answers `GET /teachers/StudEmgContacts.html?sectionid=…`; `/teachers/home.html` answers 200 HTML. Both record `referer` on the request entry. Export a helper `emergencyHtml(rows: [{ student, g1: [name, email], g2: [name, email] }])` that builds the observed table (header `Student | Guardian 1 | G1 Email | G1 Phone | G1 Faculty | Guardian 2 | G2 Email | G2 Phone | G2 Faculty`, made-up values, `Last, First` names).

- [ ] **Step 1: Write the failing parser tests** in `psEmergencyContacts.test.js`, using `emergencyHtml`:
  - `parses each row into student, g1 and g2 name and email` (two rows; emails come back lower-case; an empty G2 cell gives `{ name: null, email: null }`).
  - `decodes entities and trims` (`O&#39;Brien,  Kim` → `O'Brien, Kim`; `&amp;` decoded).
  - `finds the table by header text, ignoring a layout table before it`.
  - `a header without G2 Email throws` (expect `/header not found/`).
  - `slotsByDcid joins by lastfirst, any case and spacing` and `duplicate roster names join neither` (two roster entries `Lee, Ana` → the map has neither dcid).
- [ ] **Step 2: Run** `npx vitest run server/lib/psEmergencyContacts.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `server/lib/psEmergencyContacts.js` (regex parse in the style of `server/lib/parseSupportSummary.js`; no new dependency).
- [ ] **Step 4: Write the failing `teacherPage` tests** in the `PowerSchoolWeb` block: `teacherPage sends the Referer and no X-Requested-With`; `a Security Violation page is PS_SECURITY` (fake `failRead: (name) => name === 'StudEmgContacts.html' && '<h1>Security Violation Logged</h1>'`); `a redirect is PS_SESSION with sessionEnded`.
- [ ] **Step 5: Implement** `teacherPage` and the fake's two pages.
- [ ] **Step 6: Run** `npx vitest run server/lib/psEmergencyContacts.test.js server/services/psAlertsSync.test.js`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(ps): read and parse the Emergency Contact List (#66)`.

### Task 2: Store guardian slots and the correspondence code on every alert sync

**Files:**
- Modify: `server/db/schema.sql`, `server/db/index.js` (MIGRATIONS)
- Modify: `server/lib/psAlerts.js` (`CONTACT_FIELDS`)
- Modify: `server/services/psAlertsSync.js`, `server/services/psAlertStore.js`
- Test: `server/services/psAlertsSync.test.js`, `server/db/index.test.js`

**Interfaces:**
- Consumes: Task 1 `teacherPage`, `parseEmergencyContacts`, `slotsByDcid`.
- Produces (schema): table `student_ps_guardians (student_id INTEGER NOT NULL REFERENCES students(id), slot INTEGER NOT NULL CHECK (slot IN (1, 2)), name TEXT, email TEXT, PRIMARY KEY (student_id, slot))`; columns `student_powerschool.correspondence TEXT` (raw `x_homeemail`) and `student_powerschool.guardians_synced_at TEXT`.
- Produces: `CONTACT_FIELDS` gains `{ field: 'x_homeemail', column: 'correspondence' }` (so `applyPsAlerts` stores it with the other contact fields).
- Produces: `applyPsGuardians(db, byDcid: Map<dcid, { g1, g2 }>, { now }) → { students }` in `psAlertStore.js`: per matched student, in one transaction, deletes their `student_ps_guardians` rows, inserts slot 1 and slot 2 (a slot with neither name nor email is not inserted), and upserts `student_powerschool.guardians_synced_at = now`. Students not in the map are untouched.
- Produces: `syncPsAlerts` summary gains `guardians: { read: number, failed: number, students: number }`.

- [ ] **Step 1: Write the failing tests** in the `syncPsAlerts` block:
  - `stores each student's guardian slots, the correspondence code and guardians_synced_at` (fake `emergency` for 9001; assert rows `(slot 1, 'lee, ana'-style name as given, email)`; `correspondence` equals the fake `x_homeemail` value; requests show `home.html` before `StudEmgContacts.html` and the list's `referer` is `/teachers/home.html`).
  - `a list that fails keeps last-known guardians and still stores alerts` (pre-insert a slot row; fake `emergency: { 9001: { status: 500 } }`; alerts for the section are stored, the old slot row and old `guardians_synced_at` remain, `guardians.failed === 1`).
  - `a Security Violation on the list stops the sync` (rejects with `PS_SECURITY`).
  - `a student read again with a changed list replaces both slots`.
  - In `server/db/index.test.js`: `an existing database gains correspondence and guardians_synced_at` (create `student_powerschool` without them, run `migrate`, check `PRAGMA table_info`).
- [ ] **Step 2: Run** `npx vitest run server/services/psAlertsSync.test.js server/db/index.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `psAlertsSync.js`, after a section's alert read succeeds, read the list in its own `try`: `teacherPage('/teachers/home.html')`, then `teacherPage('/teachers/StudEmgContacts.html?sectionid=' + sectionDcid, { referer: '/teachers/home.html' })`, parse, join with the roster the section read already fetched (return it from `readSection`), merge into a `guardiansByDcid` map. `PS_SECURITY` rethrows; `PS_SESSION` with `sessionEnded` relaunches once and retries the list; any other error is logged (`${course}: guardians not read (…), kept the last ones`) and counted. After the loop, `applyPsGuardians`. Update the file's header comment.
- [ ] **Step 4: Run** the same tests, then `npx vitest run server`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ps): store guardian slots and the correspondence code each sync (#66)`.

### Task 3: Decide each parent's contact status

**Files:**
- Create: `server/lib/guardianContacts.js`, `server/lib/guardianContacts.test.js`
- Create: `server/services/guardianContactStore.js`, `server/services/guardianContactStore.test.js`

**Interfaces:**
- Produces (pure, `guardianContacts.js`):
  - `CONTACT_REASONS = { do_not_contact: 'Do not contact (PowerSchool)', deceased: 'Deceased (PowerSchool)', not_matched: 'Not matched to a PowerSchool guardian', not_checked: 'Not checked against PowerSchool yet' }`.
  - `placeParents(parents: [{ id, first_name, last_name, email }], slots: { 1?: { name, email }, 2?: { name, email } }) → Map<parentId, 1 | 2 | null>`, the spec's rule: email (trimmed, any case) equal to exactly one slot's email; otherwise every lower-case letter word of `last_name` in the slot name's part before the comma and at least one word of `first_name` after it, for exactly one slot; a slot taken by email is closed to name matches; two parents placed in one slot by name are both `null`.
  - `statusFor({ checked: boolean, slot: 1 | 2 | null, flags: { dnc_g1, dnc_g2, g1_deceased, g2_deceased }, correspondence }) → { status, primary: boolean }`: first rule that applies: `!checked` → `not_checked`; `slot == null` → `not_matched`; `dnc_g{slot}` not null and not '' → `do_not_contact`; `g{slot}_deceased` not null and not '' → `deceased`; else `contactable`, `primary` true when `correspondence` (trimmed) is `'1'` or `'2'` and equals `String(slot)`.
- Produces (store, `guardianContactStore.js`): `contactsForStudents(db, studentIds: number[]) → Map<studentId, { guardiansSyncedAt: string | null, byParent: Map<parentId, { status, primary, reason: string | null }> }>`. `checked` = the student has a non-null `student_powerschool.guardians_synced_at`. After the per-student decision, **any** parent row (any student) that is `do_not_contact` or `deceased` makes every parent row with the same `schoology_uid`, or the same lower-cased trimmed email, take that status (`do_not_contact` wins over `deceased` when both apply); to find them, the store also decides the students those matching rows belong to. `reason` = `CONTACT_REASONS[status]` or `null` for `contactable`.

- [ ] **Step 1: Write the failing pure tests:** `places by email to exactly one slot`; `the same email in both slots falls back to the name`; `places by surname plus a first-name word when the email differs`; `surname alone is not enough when both slots share it`; `a slot taken by email is closed to a name match`; `two name matches on one slot place neither`; `statusFor follows the table order` (one assertion per row of the spec's status table, including `x_dnc` value `'Y'` → `do_not_contact` and deceased `'0'` → `deceased`, the fail-safe wider than the catalogue); `primary only for code 1 or 2 on the matching slot` (code `'3'` → false).
- [ ] **Step 2: Write the failing store tests** (in-memory DB via `migrate`): `an unread student's parents are not_checked`; `a parent with no slot is not_matched`; `a flagged slot gives do_not_contact with its reason`; `a flag for one child applies to a sibling with the same uid or email` (two students; flag only on student A's record; student B's matching parent is `do_not_contact`; an unrelated parent of B stays `contactable`).
- [ ] **Step 3: Run** `npx vitest run server/lib/guardianContacts.test.js server/services/guardianContactStore.test.js`. Expected: FAIL.
- [ ] **Step 4: Implement** both modules.
- [ ] **Step 5: Run** the same. Expected: PASS.
- [ ] **Step 6: Commit** `feat: decide each guardian's contact status from PowerSchool (#66)`.

### Task 4: Apply the status in the student and Class Tools routes

**Files:**
- Modify: `server/routes/students.js` (`GET /:id`), `server/routes/tools.js` (`GET /emails/:courseId`)
- Test: `server/routes/students.test.js` (or a new `server/routes/students.contacts.test.js` mocking `getFeatures` as `students.supportSummary.test.js` does), `server/routes/tools.test.js`

**Interfaces:**
- Consumes: Task 3 `contactsForStudents`.
- Produces: with the feature on, each `parents[]` item in `GET /api/students/:id` carries `contact: { status, primary, reason }`, and the body carries `guardians_synced_at` (string or null). With it off, neither key is present.
- Produces: `GET /api/tools/emails/:courseId` adds `excluded: number` (always present; 0 with the feature off). With the feature on, parents whose status is not `contactable` are removed **before** the address de-duplication, and the legacy `students.parent_email` fallback is not used (each would-be fallback entry counts as excluded).

- [ ] **Step 1: Write the failing tests:** `feature off: parents carry no contact and nothing is filtered` (both routes); `feature on: each parent carries contact and the student guardians_synced_at`; `Class Tools leaves out not-contactable parents and counts them`; `Class Tools leaves out a guardian flagged through a sibling` (sibling in the other selected course shares the email; the address is absent from `emails`, `formatted` and `addresses`); `feature on: the legacy parent_email is not copied and is counted`.
- [ ] **Step 2: Run** `npx vitest run server/routes`. Expected: FAIL.
- [ ] **Step 3: Implement** both routes.
- [ ] **Step 4: Run** `npx vitest run server/routes`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: guardian contact status on the student page API and Class Tools (#66)`.

### Task 5: Student page and Class Tools UI

**Files:**
- Modify: `client/src/components/PsAlertReveal.jsx` (controlled reveal), `client/src/pages/StudentPage.jsx` (`ParentCard`, Family Contacts), `client/src/pages/ToolsPage.jsx`, `client/src/app.css`
- Test: `client/src/pages/StudentPage.contacts.test.jsx` (new, pattern of `StudentPage.psAlerts.test.jsx`), `client/src/pages/StudentPage.psAlerts.test.jsx` (still passes), a ToolsPage test (existing file or new `ToolsPage.contacts.test.jsx`)
- Docs: `docs/design-language.md` (extend "PowerSchool alerts"; replace its last bullet, "Guardian-contact fields … never shown here")

**Interfaces:**
- Consumes: Task 4 response fields.
- Produces: `PsAlertReveal({ alerts, syncedAt, studentId, shown?, onShownChange?, extraCount = 0 })`: controlled when `shown` is given; renders when `alerts.length + extraCount > 0`; the button reads `Show alerts (${alerts.length + extraCount})`. StudentPage owns `alertsShown` (reset when the student id changes) and passes `extraCount` = parents with status `do_not_contact` or `deceased`.

Card rules (spec "Show"), with the feature on:
- `deceased`: no card until revealed; then the card with the reason and the email as plain text.
- `do_not_contact`: name only until revealed; then the reason and the email as plain text.
- `not_matched` / `not_checked`: always a muted reason line and the email as plain text.
- No `mailto:` link and no copy button on any of the four.
- `contactable` with `primary`: a "Primary contact" label only after the reveal.
- Copy all copies only `contactable` parents with an email; beside it "{N} not copied" when N > 0; hidden when none is copyable.
- Section line: "Checked against PowerSchool DD/MM/YYYY" or "Not checked against PowerSchool yet" (muted, small).
- The "No parent/guardian contacts synced yet" message shows only when `parents` is empty, never when every parent is hidden.
- With no `contact` on the parents (feature off): exactly today's cards.

- [ ] **Step 1: Write the failing tests** (`StudentPage.contacts.test.jsx`): `a deceased parent has no card and no email in the page until Show alerts`; `a lone deceased parent shows neither a card nor the not-synced message`; `the reveal shows the deceased card with its reason and a plain email`; `a do-not-contact parent shows the name only until the reveal`; `not matched and not checked show their reason and a plain email, with no mailto link or copy button`; `Primary contact appears only after the reveal`; `Copy all copies contactable parents only and states the number not copied`; `Show alerts appears for a flagged parent when the student has no other alert, and counts them`; `with no contact field the cards are as before`. ToolsPage: `states how many guardians were not copied`.
- [ ] **Step 2: Run** `cd client && npx vitest run src/pages`. Expected: FAIL.
- [ ] **Step 3: Implement**, reusing `.alert`, `.badge`, `.text-muted` and existing tokens; any new class goes in `app.css`.
- [ ] **Step 4: Run** `cd client && npx vitest run`. Expected: PASS (including the em-dash guard and `StudentPage.psAlerts.test.jsx`).
- [ ] **Step 5: Append** the decisions to `docs/design-language.md` "PowerSchool alerts".
- [ ] **Step 6: Commit** `feat(client): hide do-not-contact guardians and leave them out of copies (#66)`.

### Task 6: Parity script and the reference docs

**Files:**
- Create: `scripts/parity-ps-guardians.js`
- Modify: `.claude/powerschool-api-reference.md`, `.claude/api-exploration-playbook.md`, `.claude/build-progress.md`, `server/lib/psAlerts.js` and `server/services/psAlertStore.js` header comments (they state the contact fields are "for #66" and "never shown")

**Interfaces:**
- Consumes: `syncPsAlerts`, `contactsForStudents`.
- Produces: `DB_PATH=<copy> node scripts/parity-ps-guardians.js` runs `syncPsAlerts` on that database, then prints counts only: lists read/failed, students with slots, and per status the number of parent rows (and `primary` count). Refuses to run without `DB_PATH`, and refuses a `DB_PATH` that resolves to `~/prism/data/students.db`.

- [ ] **Step 1: Write the script** (pattern of `scripts/parity-ps-alerts.js`).
- [ ] **Step 2: Docs.** Add to the PowerSchool reference a dated section "Guardian contacts (#66, verified 2026-10-21)" with exactly the spec's "What the spike showed" findings (the Emergency Contact List path, click path and header; the correspondence pop-up shape; the codes; the match counts; probe `scripts/probe-ps-guardian-contacts.js`), and annotate the "#66 resolution" and Frontier lines that called per-guardian identities unexposed (keep them, mark superseded). Playbook Frontier: the guardian identities line → found (Emergency Contact List). Build progress: a #66 entry.
- [ ] **Step 3: Run** `npx vitest run` at the root (server, `mcp/`, `scripts/`). Expected: PASS.
- [ ] **Step 4: Commit** `docs: guardian contacts (#66) in the PowerSchool reference; parity script`.

## After the tasks (the controller, not a subagent)

Whole-branch review; root and client test suites; `npm run build`; `npm run check:mobile` against a dev server; parity run on a scratch copy (`sqlite3 -readonly ~/prism/data/students.db ".backup <scratchpad>/guardians.db"`); a live check of the student page and Class Tools on a dev server on that copy (`PORT=3002`), then `npm run dev:stop` and delete the copy; merge to `main`, push, CI green, prod `/api/version` serving the commit; #66 closed with evidence; follow-up issue for filling `parents.phone` from the list; memory updated.
