# Do-not-contact guardians (#66): design

Date: 21 October 2026. Issue: #66 (milestone "PowerSchool data"). Related: #65, #117, #163, #167.

## Intent

Schoology syncs every guardian into Prism's `parents` table, including guardians PowerSchool marks as not to
be contacted (the issue's example: a deceased Guardian 2). Prism shows them as ordinary contacts, and two
features copy their email addresses: **Copy all** on the student page and the **Parent emails** list in Class
Tools. A teacher can email a deceased guardian, or a guardian the school must not contact, by accident. This
is a safeguarding risk in a live feature.

The fix: Prism learns, on every sync, which Prism parent is PowerSchool's Guardian 1 and which is Guardian 2.
It applies PowerSchool's per-guardian flags to them, and leaves every guardian it cannot clear out of every
copy.

## Rules (Graham's decisions)

- **Refresh and reconcile on every sync, never capture once** (#66 comment, 31 May 2026). A flag that is
  cleared in PowerSchool clears in Prism. Prism changes stored data only on a successful read; a failed read
  keeps the last-known data, and Prism shows when it was read.
- **Fail safe.** When Prism is unsure whether a guardian may be contacted, it treats the guardian as
  do-not-contact.
- **Correspondence codes mark the primary contact, not an exclusion** (Graham, 21 October 2026).
  `X_HomeEmail` = 1 or 2 means that guardian is the primary contact; the other guardian is still copied.
- **With the `powerschool_alerts` feature off, Prism behaves as it does today** (Graham, 21 October 2026): no
  check, no labels, every parent copied. The fail-safe applies only when the feature is on. This keeps parent
  email working at a school without PowerSchool (#167).

## What the spike showed (21 October 2026)

Read only, over plain HTTP on the attendance LTI session, no browser. Every value was masked; the probe printed
headers, lengths and counts only. Probe: `scripts/probe-ps-guardian-contacts.js`. Data: the 9 active sections,
110 roster rows, 219 Prism parents; Prism's parents read from prod's database, opened read only.

- **Contact fields** (`stuFieldValues.json`, already read by the #117 alert sync and stored raw in
  `student_powerschool`): `x_dnc_g1`, `x_dnc_g2`, `x_g1deceased`, `x_g2deceased` were null for all 110.
  `x_homeemail` is a one-character code on all 110: `3` ×97, `1` ×7, `2` ×6. The catalogue confirms the
  codes: G1 Correspondence `in 1`, G2 Correspondence `in 2`, G1 and G2 Correspondence `in 3`.
- **Catalogue rules** (`getAlertTypes.json`): Do Not Contact Guardian 1 / 2 (10672509 / 10672510) are
  `notblank`; Deceased Guardian 1 / 2 (10593864 / 10733416) are `in 1`. Their pop-ups are
  `mbapop_dnc1.html`, `mbapop_dnc2.html`, `mbapop_deceasedg2.html` (Deceased Guardian 1 has none). Every current
  student has these fields blank, so those pop-ups were left unread.
- **The Emergency Contact List is the slot map.** `GET /teachers/StudEmgContacts.html?sectionid={sectionDcid}`,
  reached as a teacher clicks to it (`/teachers/home.html` first, then the list with home as Referer): 200
  for 9 of 9 sections, no security violation. One HTML table per section, header
  `Student | Guardian 1 | G1 Email | G1 Phone | G1 Faculty | Guardian 2 | G2 Email | G2 Phone | G2 Faculty`,
  one row per student, every cell set on all 110 rows, one email per email cell. Guardian names have the shape
  `Last, First`. All 110 rows joined to the section roster by the `Student` cell equal to the roster's
  `lastfirst`.
- **Matching Prism parents to slots:**
  - by email to exactly one slot: 188 of 219 parents; for each of these, first name plus surname named the
    same slot when it named any (178 agree, **0 disagree**);
  - the same email in both slots: 3 parents (3 students), each placed by first name plus surname;
  - a Prism email that is in neither slot: 19 parents; 18 placed by first name plus surname;
  - no Prism email: 9 parents, all placed by first name plus surname;
  - placed by surname alone, or not at all: **1 parent**, who would show as "not matched".
  - Surnames are shared between the two slots for 31 of 110 students, so surname alone is not enough.
- **The correspondence pop-up** (`mbapop_emailcorr.html`, opened from the attendance page as #163's Support
  Summary read is): one table `Guardian | Email | Phone`, one row for code 1 or 2, two rows for code 3; 9 of
  9 had no other text. It lists the correspondence guardians without their slot. The code and the Emergency
  Contact List hold the same answer with one read per section instead of one per
  student, so Prism leaves the pop-up unread. The free-text note the issue quoted in May was not on any of the 9.
- **No notes name a contact guardian.** Divorced pop-ups (3 students) hold a single line of 41 to 49
  characters; none of 19 Student Support Summaries has a contact word (G1, G2, both, contact, correspondence,
  custody, mother, father, email) in any row.

## Goals

1. Each Prism parent of a checked student gets a contact status from PowerSchool on every sync.
2. **Copy all** (student page) and **Parent emails** (Class Tools) leave out every parent whose status is not
   contactable, and state how many they left out.
3. The student page shows each parent's status: the reason a parent is left out, or "Primary contact".
4. The page shows when the guardians were last checked against PowerSchool.

## Non-goals

- Reading the DNC or deceased pop-ups for the reason text (no current student has one; the flag is enough).
- Reading the correspondence pop-up (the code holds the same answer).
- Filling `parents.phone` from the Emergency Contact List's phone columns: a follow-up issue.
- Contact status in PrisMCP: PrisMCP tools return no guardian contacts today (checked 21 October 2026), and
  this work keeps it that way.
- Reading students outside the teacher's current classes (archived-only students are not on any roster Prism
  reads; they keep their last-known status, or show "not checked").

## Anti-goals

- A guardian Prism cannot clear is copied. Any doubt means left out.
- A failed read clears a flag, or a guardian's status, that a past read set.
- A wrong click path logs a security violation at school. The list is read only through home.html, and a
  "Security Violation Logged" page stops the sync (`PS_SECURITY`), as every PowerSchool read does today.
- A dash or an em dash in UI copy (guard test).

## Design

### Read (in the existing alert sync)

`server/services/psAlertsSync.js` already reads every active section's roster and contact fields. Per
section it also reads the Emergency Contact List, on the same PowerSchool session:

1. `GET /teachers/home.html` (no Referer), then
2. `GET /teachers/StudEmgContacts.html?sectionid={sectionDcid}` with `Referer: {PS_BASE}/teachers/home.html`.

These are page loads, not the XHR reads `PowerSchoolWeb.read` and `.page` send, so `PowerSchoolWeb` gets a
method for a teacher page with a given Referer. A security-violation page throws `PS_SECURITY`; a redirect or
an error status is `PS_SESSION` (relaunch once, as the section read does now).

A pure parser (`server/lib/`) turns the page into `Map<studentdcid, { g1: { name, email }, g2: { name, email
} }>`: it finds the table whose header holds `Student`, `Guardian 1`, `G1 Email`, `Guardian 2`, `G2 Email`
(by header text, not column position), and joins each row to the roster through `lastfirst`. A header that
lacks one of those columns throws, so the section's guardians are not stored (last-known kept). Two roster
students with the same `lastfirst` in one section are left out of the join (not stored). If the row carries a
student id or link (not checked in the spike), the builder may join on it instead.

The list read is independent of the alert read: a list that fails leaves the section's alerts stored and its
guardians at their last-known values.

### Store

- New table `student_ps_guardians (student_id, slot INTEGER 1|2, name TEXT, email TEXT, PRIMARY KEY
  (student_id, slot))`: what the list showed, replaced per student on each successful read.
- `student_powerschool` gains `correspondence TEXT` (raw `x_homeemail`) and `guardians_synced_at TEXT`. Both
  go in `schema.sql` and in the `MIGRATIONS` array in `server/db/index.js`.
- `x_homeemail` is added to `CONTACT_FIELDS` in `server/lib/psAlerts.js`.

Storing guardian names and emails from PowerSchool is the same kind of data as `parents` from Schoology, kept
the same way (ADR 0002).

### Decide (at read time, a pure function)

The status is calculated when the page or list is requested, from the stored slots and the current `parents`
rows, so a parent Schoology adds between PowerSchool reads is checked at once (and is "not matched" until a
list read holds them).

Placing a parent in a slot, in order:
1. their email (trimmed, any case) equals the email of exactly one slot;
2. otherwise, every word of their last name is in the part of one slot's name before the comma, and a word of
   their first name is in the part after it, for exactly one slot;
3. otherwise, not placed.

A slot that a parent took by email is not available to a name match. Two parents placed in one slot by name
are both not placed.

Status (the first row that applies decides):

| Status | When | Copied |
|---|---|---|
| (none) | the `powerschool_alerts` feature is off | yes |
| `not_checked` | the student has no successful guardian read | no |
| `not_matched` | the parent could not be placed in a slot | no |
| `do_not_contact` | the slot's `dnc_gN` holds any value | no |
| `deceased` | the slot's `gN_deceased` holds any value | no |
| `contactable` | otherwise; `primary: true` when `correspondence` is `1` or `2` and names this slot | yes |

"Any value" is deliberately wider than the catalogue's `in 1`: an unexpected value is treated as a flag (fail
safe). The legacy `students.parent_email` (CSV import, no name) is `not_checked` when the feature is on.

**A flag for one child applies to every child** (my call, from the fail-safe rule). Siblings each have their
own PowerSchool record, so a guardian may be flagged on one child's record and not on another's. A parent who
is `do_not_contact` or `deceased` for any student is that status for every student whose `parents` row has
the same `schoology_uid`, or the same email (any case). Class Tools filters before it removes duplicate
addresses, so an unflagged sibling never lets the address through.

**No teacher override** (my call). A guardian Prism leaves out stays out until PowerSchool clears them; the
teacher can still contact them deliberately from PowerSchool or, for `not_matched` and `not_checked`, from the
email shown on the card.

### Show

The student route returns each parent with `contact: { status, primary, reason }` and the student's
`guardians_synced_at` (only when the feature is on).

The student page may be on a projector in a parent conference, so family facts stay behind the page's existing
**Show alerts** click (`PsAlertReveal`, hidden again on every page load; `docs/design-language.md` "PowerSchool
alerts", 18 October 2026).

- **`deceased`** (Graham, 21 October 2026): the guardian's whole card is hidden. After **Show alerts**, the
  card appears with the reason "Deceased (PowerSchool)" and the email as plain text, without a link or a copy
  button. A student whose only synced parent is hidden shows no card, and also no "No parent/guardian contacts
  synced yet" message (that message would be false).
- **`do_not_contact`** (Graham, 21 October 2026): the card shows the guardian's name only. No email, no
  `mailto:` link, no copy button, no reason. After **Show alerts**, the card adds the reason "Do not contact
  (PowerSchool)" and the email as plain text, still without a link or a copy button.
- **`not_matched` and `not_checked`** (my call: these state nothing about the family): always visible, a
  muted line with the reason ("Not matched to a PowerSchool guardian", "Not checked against PowerSchool yet")
  and the email as plain text, without a link or a copy button.
- **"Primary contact"** (my call: it is the same fact as the Correspondence G1 or G2 alert, which is hidden
  today): a label shown only after **Show alerts**.
- **Copy all:** copies only contactable parents, and states "N not copied" beside it when any are left out
  (neutral wording, because it is always visible). Hidden when none is contactable.
- **Section header:** "Checked against PowerSchool DD/MM/YYYY" (`formatDate`), or "Not checked against
  PowerSchool yet".
- **Class Tools, Parent emails** (`server/routes/tools.js`): the server leaves out every parent who is not
  contactable, and the legacy `parent_email` when the feature is on; the response adds the number left out,
  and the page states it in neutral words ("N guardians not copied").
- **The reveal button** must appear when a student has a `do_not_contact` or `deceased` parent, even with no
  other PowerSchool alert, and its count includes them.

Exact wording and layout are the builder's, within the house rules (no em dash, en-GB dates). Record the
pattern in `docs/design-language.md`.

## Constraints

- Plain HTTP only, one Emergency Contact List read per section per sync, on the session the alert sync already
  starts. No browser.
- Tests: Vitest beside each new module (parser and decision from masked fixtures, sync with a fake fetch,
  route), client tests for the card, Copy all and Class Tools. No real names, emails or phone numbers in a
  fixture.
- Docs: `.claude/powerschool-api-reference.md` (a dated "Guardian contacts (#66)" section with the shapes
  above), `.claude/api-exploration-playbook.md` (Frontier), `.claude/build-progress.md`,
  `docs/design-language.md`, AGENTS.md if a rule changes.
- Verification: a parity run of the sync against a database copy (counts per status, never values), a live
  check on a dev server whose scratch data is deleted afterwards, both test suites, the build,
  `npm run check:mobile`, CI green, prod serving the commit.

## The builder's calls

- Module and function names, the parser's handling of whitespace and HTML entities, and the exact UI layout.
- Whether the list read sits inside `readSection` or in a second loop over the same sections.
- The masked fixture HTML, built from the observed header and shapes.
