# Guardian details from PowerSchool (#173) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show and copy each matched guardian's email and phone from PowerSchool, let a teacher add an extra phone and email in the card's edit mode, and close three small #66 tidy-ups.

**Architecture:** The Emergency Contact List parser (#66) also keeps each slot's phone; slots store it. The contact store returns each uniquely placed parent's PowerSchool email and phone; the student route sends them and the Class Tools route copies them. The parent card shows them and gains an edit mode for the teacher's extra phone and email.

**Tech Stack:** Node ESM, Express, better-sqlite3, Vitest; React 18 + React Testing Library.

**Spec:** issue #173 body ("Design (Graham, 21/10/2026)") plus the #66 spec `docs/superpowers/specs/2026-10-21-do-not-contact-guardians-design.md`, whose hiding and copy rules are unchanged.

## Global Constraints

- Copy rule unchanged (#66): every `contactable` guardian is copied; any other status is never copied, and none of its addresses (PowerSchool, Schoology or extra) is copied.
- Address for a guardian: the PowerSchool slot email when the parent is uniquely placed in a slot and the slot has an email; otherwise the Schoology email (`parents.email`).
- Phone for a guardian: the PowerSchool slot phone when uniquely placed; the teacher's extra phone (`parents.phone`) is shown in addition, labelled.
- Extra email (`parents.extra_email`, new): copied with the guardian's address when the guardian is copyable; never for a left-out guardian.
- Hiding unchanged (#66): `deceased` card hidden until Show alerts; `do_not_contact` name only until then; restricted statuses never get `mailto:`, `tel:` or a copy button, for any address or number.
- With `powerschool_alerts` off: Schoology email and the teacher's phone as today, plus the extra email (the teacher's own data) shown and copied.
- Probe facts (21/10/2026): one number per phone cell; G1 Phone set on 108 of 110 rows, G2 Phone on 107; 208 of 220 phone cells are 8 digits, 7 other formats (10 to 14 digits, one with a space, one with a hyphen), 5 empty. A list without phone columns still parses (phones null).
- New columns in both `server/db/schema.sql` and `MIGRATIONS` in `server/db/index.js`.
- UI copy: no em dash, no en dash; labels exact: "Extra phone", "Extra email", "Added in Prism". Colours only from `client/src/app.css` tokens; phone rules only in the PHONE LAYOUT block.
- Fixtures: no real names, emails or phone numbers.
- Tests: `npx vitest run` at the root and `cd client && npx vitest run`; `npm run build`.

## Review Focus

1. A uniquely placed parent whose slot has no email: the Schoology email is shown and copied (Task 1 test `a slot with no email falls back to the Schoology email`).
2. Two parents placed in one slot (shared email): neither gets the slot's phone or email; each keeps its Schoology email (Task 1 test `a shared slot gives no PowerSchool details`).
3. A parent with no Schoology email but a PowerSchool email: copied by Class Tools (Task 1 test `a parent with only a PowerSchool email is copied`).
4. A left-out guardian with an extra email: neither address copied, both counted once as not copied (Task 1 test).
5. A deceased guardian with an extra phone: nothing of the card, the phone included, shows before Show alerts (Task 2 test).

---

### Task 1: Server: PowerSchool phone, extra email, routes, tidy-ups

**Files:** `server/lib/psEmergencyContacts.js` (+ test), `server/db/schema.sql`, `server/db/index.js` (+ `index.test.js`), `server/services/psAlertStore.js` (`applyPsGuardians`), `server/services/guardianContactStore.js` (+ test), `server/routes/students.js` (+ `students.test.js`), `server/routes/tools.js` (+ `tools.test.js`), `server/services/powerschoolWeb.js`, `server/testing/fakePowerSchoolWeb.js` (`emergencyHtml` gains phones).

**Interfaces:**
- `parseEmergencyContacts` rows: `g1: { name, email, phone }`, `g2: { name, email, phone }`; phone = the cell text trimmed (entities decoded, runs of spaces collapsed), `null` when empty or when the page has no `G1 Phone` / `G2 Phone` column (the five required headers stay as they are).
- Schema: `student_ps_guardians.phone TEXT`; `parents.extra_email TEXT`. `applyPsGuardians` stores the phone; a slot with no name, email or phone is not inserted.
- `contactsForStudents` byParent entries gain `ps: { email: string|null, phone: string|null } | null`: the slot's email and phone when the parent is uniquely placed in a slot (use `placeParents` from `server/lib/guardianContacts.js`; a slot two parents share gives `null`), else `null`. The status fields are unchanged.
- `GET /api/students/:id` (feature on): each parent's `contact` carries `ps` as above; `extra_email` is a column so it arrives on every parent row.
- `PUT /api/students/:id/parents/:parentId`: body `{ phone?, extra_email? }`; only keys present are updated; `''` or `null` clears; an `extra_email` without `@` answers 400 `{ error: 'Extra email must be an email address' }`. Responds with the updated row (as today).
- `GET /api/tools/emails/:courseIds`: parent rows no longer need a Schoology email to be considered; a copyable parent contributes its address (rule above, skipped when empty) and its `extra_email`, each as an entry named `"First Last (parent of Student)"`; a left-out parent's addresses all go to `withheld`. The legacy `parent_email`, feature on: withheld for any student with no `parents` rows, whether or not other students have rows (tidy-up). De-duplication and the `excluded` count as today.
- Tidy-up: `PowerSchoolWeb#page` and `#teacherPage` share one private helper for the fetch, cookie, security-violation and status checks; behaviour and tests unchanged.

- [ ] **Step 1: Failing tests:** parser `keeps each slot's phone` and `a list without phone columns parses with null phones`; store `a uniquely placed parent gets its slot's email and phone`, `a slot with no email falls back to the Schoology email` (route level: shown and copied), `a shared slot gives no PowerSchool details`; route `PUT updates only the keys sent`, `PUT refuses an extra email without @`, `GET sends contact.ps`; tools `copies the PowerSchool address instead of the Schoology one`, `a parent with only a PowerSchool email is copied`, `copies a copyable parent's extra email`, `a left-out guardian's extra email is withheld and counted once`, `feature off: the extra email is copied`, `feature on: a student with only a legacy parent_email is counted in a mixed class`; migration test for both columns.
- [ ] **Step 2: Run** `npx vitest run server`; expected FAIL on the new tests only.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run` (root); expected PASS.
- [ ] **Step 5: Commit** `feat(contacts): guardian email and phone from PowerSchool; extra email (#173)`.

### Task 2: Client: the parent card and Copy all

**Files:** `client/src/pages/StudentPage.jsx`, `client/src/services/api.js`, `client/src/app.css` (only if a class is needed), tests in `client/src/pages/StudentPage.contacts.test.jsx` and the existing StudentPage tests that use `updateParentPhone`.

**Interfaces:**
- `api.js`: `updateParent(studentId, parentId, { phone, extra_email })` replaces `updateParentPhone` (update every import and mock).
- Card (contactable, or feature off): the address from the rule above as a `mailto:` link with its copy button; the PowerSchool phone as a `tel:` link; then, when set, the teacher's extra phone and extra email, each with a muted "Added in Prism" label (extra email also a `mailto:` link with a copy button). An **Edit** button (`.ghost`) opens two inputs labelled "Extra phone" and "Extra email" with Save and Cancel; Save calls `updateParent` and reloads; a 400 message shows under the inputs.
- Restricted statuses: every address and number as plain text (no links, no copy buttons); `deceased` and `do_not_contact` show none of them before Show alerts (as for the email today); no Edit button on a `deceased` or `do_not_contact` card.
- Copy all: for each copyable parent, its address and its extra email.
- Tidy-up: the "Checked against PowerSchool …" line is hidden while every parent card is hidden (only deceased parents, before the reveal).

- [ ] **Step 1: Failing tests:** `shows the PowerSchool email and phone for a matched guardian`; `falls back to the Schoology email`; `shows the teacher's extra phone and email with Added in Prism`; `Edit saves the extra phone and email`; `Edit shows the server's message for a bad email`; `a deceased guardian's extra phone is hidden before the reveal`; `a restricted card has no tel or mailto link for any detail`; `Copy all includes a copyable guardian's extra email`; `the checked line is hidden while every card is hidden`; `feature off: the extra email shows and is copied`.
- [ ] **Step 2: Run** `cd client && npx vitest run src/pages`; expected FAIL on the new tests only.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd client && npx vitest run` and `npm run build`; expected PASS.
- [ ] **Step 5: Commit** `feat(client): guardian details from PowerSchool; extra phone and email (#173)`.

### Task 3: Docs

**Files:** `.claude/powerschool-api-reference.md` ("Guardian contacts (#66 …)": a dated line on the phone columns and on which email is which, from the #173 issue body only), `docs/design-language.md` ("PowerSchool alerts" family-contacts bullets), `.claude/build-progress.md` (a #173 entry), `scripts/parity-ps-guardians.js` (also print how many parents have a PowerSchool phone and how many PowerSchool emails differ from Schoology's, counts only).

- [ ] **Step 1: Write**, then run the house checker on the new prose.
- [ ] **Step 2: Run** `npx vitest run` (root); expected PASS.
- [ ] **Step 3: Commit** `docs: guardian details from PowerSchool (#173)`.
