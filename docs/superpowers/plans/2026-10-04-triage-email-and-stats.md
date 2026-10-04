# Triage email menus + Dashboard stats strip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Copy Outlook-ready student address lists from the Make-up tests, Late work and Resubmissions panels, add a per-row `mailto:` link, and add a Dashboard stats strip (status line + four overdue tiles that jump to their panel).

**Architecture:** The server adds `studentEmail` to the triage rows it already builds. A pure client module (`emailLists.js`) decides who each menu item copies and builds the strings. A self-contained `EmailMenu` component (button, popover, status, copy-by-hand fallback) sits in each panel header. A `StatsStrip` component reads the triage payload the Dashboard already receives, so there's no new fetch.

**Tech Stack:** Node ESM + Express + better-sqlite3 (server), React + react-router (client), Vitest (server and client), React Testing Library + jsdom (client).

**Spec:** `docs/superpowers/specs/2026-10-04-triage-email-and-stats-design.md`

## Global Constraints

- UI copy: no em dashes. Use hyphens, commas or colons.
- Colours only via CSS custom properties from `client/src/app.css` (`var(--danger)`, `var(--card-bg)`, ...). No hex values in components.
- Every phone-only CSS rule goes in the single `PHONE LAYOUT` `@media (max-width: 768px)` block at the end of `client/src/app.css`.
- Address string format: `a@x; b@x` (semicolon + space), deduplicated case-insensitively.
- Status text: `N addresses copied. Paste into Outlook To or Bcc.` (singular "address").
- Row mail subject: `<title>: <late work | make-up test | resubmission>`.
- The repo is PUBLIC: test fixtures use made-up names and `@example.test` addresses only.
- This machine is prod (`127.0.0.1:3001`). Never kill by port. A dev server runs as `PORT=3002 DB_PATH=<a /tmp copy> npm run dev` and stops with `PORT=3002 npm run dev:stop`. Never publish or unsubmit from a dev server.
- UI copy says "the server", never "Mac mini".
- Server tests: `npx vitest run <path>` from the repo root. Client tests: `cd client && npx vitest run <path>`.

## Review Focus

1. **A panel longer than the 5-row limit.** The `@` menu must count and copy every listed student, not just the visible five. Test in Task 4.
2. **One student with two late assessments.** They count once in a tier and their address appears once. Tests in Tasks 2 and 4.
3. **The clipboard is unavailable or rejects** (permission denied, older Safari). The addresses appear in a pre-selected field to copy by hand, never a silent failure. Test in Task 3.
4. **Tapping a tile whose panel isn't rendered** (the Resubmissions panel hides itself when empty). Nothing happens, and nothing throws. Test in Task 5.
5. **A student with no email in Prism.** There's no ✉ on their row, the menu still counts them, and the status says how many had no email. Even when no address can be copied, it says so instead of copying an empty string. Tests in Tasks 2, 3 and 4.

---

### Task 1: `studentEmail` on triage rows (server)

**Files:**
- Modify: `server/services/triageCommon.js` (`roster()`, ~line 38)
- Modify: `server/services/triage.js` (make-up row push ~line 186; late-work row push ~line 248)
- Modify: `server/services/resubmissions.js` (`resubmissionRows()` row push ~line 401)
- Test: `server/services/triage.test.js`

**Interfaces:**
- Produces: every object in `getTriage(...).lateWork`, `.makeUps` and `.resubmissions` gains `studentEmail: string | null`. `feedbackOwed` is unchanged. MCP `get_triage` returns the same payload, so it gains the field too, with no MCP code change.

- [ ] **Step 1: Write the failing test.** Append to `server/services/triage.test.js`. It reuses that file's helpers `student`, `assignment`, `grade`, `testItem`, `missed`, `epoch`, `TODAY`, `AFTER_SCHOOL`, plus the imported `requestResubmission`:

```js
describe('getTriage — studentEmail (#137)', () => {
  const sqlAt = (iso) => `${iso} 04:00:00`;
  const setEmail = (id, email) => db.prepare('UPDATE students SET email = ? WHERE id = ?').run(email, id);

  test('late work rows carry the student email, null when Prism has none', () => {
    const ada = student('u1', 'Ada', 'L');
    student('u2', 'Bo', 'M');
    setEmail(ada, 'ada@example.test');
    assignment('a1', 'Essay', '2026-10-05');
    const t = getTriage(db, { today: TODAY });
    expect(Object.fromEntries(t.lateWork.map((r) => [r.studentName, r.studentEmail])))
      .toEqual({ 'Ada L': 'ada@example.test', 'Bo M': null });
  });

  test('make-up rows carry the student email', () => {
    const ada = student('u1', 'Ada', 'L');
    setEmail(ada, 'ada@example.test');
    const quiz = testItem('q1', 'Unit 1 test', '2026-10-13');
    missed(ada, quiz);
    const t = getTriage(db, { today: TODAY, now: AFTER_SCHOOL });
    expect(t.makeUps.map((r) => r.studentEmail)).toEqual(['ada@example.test']);
  });

  test('resubmission rows carry the student email', () => {
    const s = student('u1', 'Maya', 'Chen');
    setEmail(s, 'maya@example.test');
    const a = assignment('a1', 'CP1', '2026-09-21');
    grade(s, a, { score: 60, submitted_at: epoch('2026-09-25'), latest_revision_at: epoch('2026-09-21') });
    requestResubmission(db, { studentId: s, assignmentId: a, lessons: 3, requestedAt: sqlAt('2026-10-09') });
    const rows = getTriage(db, { today: TODAY }).resubmissions;
    expect(rows.map((r) => [r.state, r.studentEmail])).toEqual([['waiting', 'maya@example.test']]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npx vitest run server/services/triage.test.js -t "studentEmail"`
Expected: 3 FAIL. `studentEmail` is `undefined`.

- [ ] **Step 3: Implement.**

In `server/services/triageCommon.js` `roster()`, add `s.email` to the select list:

```js
    SELECT s.id, s.schoology_uid, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher, s.email
```

In `server/services/triage.js`, in both the `makeUps.push({...})` and the `lateWork.push({...})` objects, add `studentEmail: st.email ?? null,` right after `studentName: fullName(st),`. The make-up push becomes:

```js
          studentId: st.id, studentUid: st.schoology_uid, studentName: fullName(st), studentEmail: st.email ?? null, ...courseFields,
```

The late-work push becomes:

```js
              studentId: st.id, studentUid: st.schoology_uid, studentName: fullName(st), studentEmail: st.email ?? null, ...courseFields,
```

In `server/services/resubmissions.js` `resubmissionRows()` (its `students` come from `roster()`), change the row's student line to:

```js
        studentId: st.id, studentUid: st.schoology_uid, studentName: fullName(st), studentEmail: st.email ?? null,
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `npx vitest run server/services/triage.test.js server/services/resubmissions.test.js mcp/handlers.test.js`
Expected: all PASS, including the 3 new tests.

- [ ] **Step 5: Commit.**

```bash
git add server/services/triageCommon.js server/services/triage.js server/services/resubmissions.js server/services/triage.test.js
git commit -m "feat(triage): studentEmail on late, make-up and resubmission rows (#137)"
```

---

### Task 2: `emailLists.js` (pure client logic)

**Files:**
- Create: `client/src/lib/emailLists.js`
- Test: `client/src/lib/emailLists.test.js`

**Interfaces:**
- Consumes: triage rows with `studentId`, `studentEmail`, `studentName`, `tone` (`'red'|'amber'|'green'`), `assignmentId`, `title`, `blockNumber`, plus `kind` (late) or `state` (resubmissions).
- Produces:
  - `type EmailKind = 'makeUps' | 'late' | 'resubmissions'`
  - `stillOwing(kind: EmailKind, row) → boolean`
  - `buildEmailMenu(kind, rows, { showCourse = false } = {}) → { tiers: MenuItem[], byAssessment: MenuItem[] }`
  - `type MenuItem = { key: string, label: string, students: number, emails: string[], missing: number }`. `label` has no count. The UI renders `${label} (${students})`. `emails` holds one entry per student that has an email. `missing` = students without one.
  - `uniqueAddresses(emails: string[]) → string[]`: trimmed, empties dropped, case-insensitive dedupe that keeps the first spelling and the original order.
  - `formatAddresses(emails) → string`, i.e. `uniqueAddresses(emails).join('; ')`
  - `copiedMessage(count: number, missing = 0) → string`
  - `mailtoFor(row, kind: EmailKind) → string | null`

- [ ] **Step 1: Write the failing tests.** Create `client/src/lib/emailLists.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  stillOwing, buildEmailMenu, uniqueAddresses, formatAddresses, copiedMessage, mailtoFor,
} from './emailLists.js';

const row = (o) => ({
  studentId: 1, studentName: 'Ada L', studentEmail: 'ada@example.test', tone: 'red',
  assignmentId: 9, title: 'CPT 1', blockNumber: null, ...o,
});

describe('stillOwing', () => {
  it('late: outstanding owes, submitted_late does not', () => {
    expect(stillOwing('late', row({ kind: 'outstanding' }))).toBe(true);
    expect(stillOwing('late', row({ kind: 'submitted_late' }))).toBe(false);
  });
  it('resubmissions: waiting owes, arrived does not', () => {
    expect(stillOwing('resubmissions', row({ state: 'waiting' }))).toBe(true);
    expect(stillOwing('resubmissions', row({ state: 'arrived' }))).toBe(false);
  });
  it('makeUps: every row owes', () => {
    expect(stillOwing('makeUps', row({}))).toBe(true);
  });
});

describe('buildEmailMenu', () => {
  const late = [
    row({ studentId: 1, studentEmail: 'a@example.test', tone: 'red', kind: 'outstanding', assignmentId: 9, title: 'CPT 1' }),
    row({ studentId: 1, studentEmail: 'a@example.test', tone: 'amber', kind: 'outstanding', assignmentId: 10, title: 'Unit 2 quiz' }),
    row({ studentId: 2, studentEmail: 'b@example.test', tone: 'amber', kind: 'outstanding', assignmentId: 9, title: 'CPT 1' }),
    row({ studentId: 3, studentEmail: 'c@example.test', tone: 'green', kind: 'outstanding', assignmentId: 9, title: 'CPT 1' }),
    row({ studentId: 4, studentEmail: 'd@example.test', tone: 'red', kind: 'submitted_late', assignmentId: 9, title: 'CPT 1' }),
  ];

  it('tiers count distinct still-owing students, narrow to broad', () => {
    const { tiers } = buildEmailMenu('late', late);
    expect(tiers.map((t) => [t.key, t.label, t.students])).toEqual([
      ['red', 'Red', 1],
      ['redAmber', 'Red + amber', 2],
      ['all', 'Everyone still owing', 3],
    ]);
    expect(tiers[2].emails).toEqual(['a@example.test', 'b@example.test', 'c@example.test']); // student 1 once, student 4 excluded
  });

  it('drops a tier that is empty or repeats the previous tier', () => {
    const rows = [
      row({ studentId: 1, tone: 'amber', kind: 'outstanding' }),
      row({ studentId: 2, studentEmail: 'b@example.test', tone: 'amber', kind: 'outstanding' }),
    ];
    expect(buildEmailMenu('late', rows).tiers.map((t) => t.key)).toEqual(['redAmber']);
  });

  it('no still-owing rows → no tiers and no assessments', () => {
    const rows = [row({ kind: 'submitted_late' })];
    expect(buildEmailMenu('late', rows)).toEqual({ tiers: [], byAssessment: [] });
    expect(buildEmailMenu('late', [])).toEqual({ tiers: [], byAssessment: [] });
  });

  it('by assessment: one item per assignment, most students first, block shown when showCourse', () => {
    const rows = [
      row({ studentId: 1, assignmentId: 9, title: 'CPT 1', blockNumber: '4' }),
      row({ studentId: 2, studentEmail: 'b@example.test', assignmentId: 9, title: 'CPT 1', blockNumber: '4' }),
      row({ studentId: 3, studentEmail: 'c@example.test', assignmentId: 11, title: 'CPT 1', blockNumber: '7' }),
    ];
    const course = buildEmailMenu('makeUps', rows, { showCourse: true }).byAssessment;
    expect(course.map((a) => [a.label, a.students])).toEqual([['CPT 1 · BK 4', 2], ['CPT 1 · BK 7', 1]]);
    const page = buildEmailMenu('makeUps', rows).byAssessment;
    expect(page.map((a) => a.label)).toEqual(['CPT 1', 'CPT 1']);
  });

  it('omits by-assessment when only one assessment is involved', () => {
    const rows = [row({ studentId: 1 }), row({ studentId: 2, studentEmail: 'b@example.test' })];
    expect(buildEmailMenu('makeUps', rows).byAssessment).toEqual([]);
  });

  it('counts students without an email as missing', () => {
    const rows = [row({ studentId: 1, studentEmail: null }), row({ studentId: 2, studentEmail: 'b@example.test' })];
    const [all] = buildEmailMenu('makeUps', rows).tiers;
    expect(all).toMatchObject({ students: 2, emails: ['b@example.test'], missing: 1 });
  });
});

describe('addresses', () => {
  it('dedupes case-insensitively, keeps first spelling and order, drops blanks', () => {
    expect(uniqueAddresses(['B@example.test', ' a@example.test ', 'b@example.test', '', null]))
      .toEqual(['B@example.test', 'a@example.test']);
    expect(formatAddresses(['a@example.test', 'b@example.test'])).toBe('a@example.test; b@example.test');
    expect(formatAddresses([])).toBe('');
  });

  it('copiedMessage: plural, singular, missing clause, nothing to copy', () => {
    expect(copiedMessage(5)).toBe('5 addresses copied. Paste into Outlook To or Bcc.');
    expect(copiedMessage(1)).toBe('1 address copied. Paste into Outlook To or Bcc.');
    expect(copiedMessage(4, 1)).toBe('4 addresses copied. Paste into Outlook To or Bcc. 1 student has no email in Prism.');
    expect(copiedMessage(4, 2)).toBe('4 addresses copied. Paste into Outlook To or Bcc. 2 students have no email in Prism.');
    expect(copiedMessage(0, 2)).toBe('Nothing copied: 2 students have no email in Prism.');
  });
});

describe('mailtoFor', () => {
  it('builds a mailto with an encoded subject per kind', () => {
    expect(mailtoFor(row({ title: 'CPT 1' }), 'late')).toBe('mailto:ada@example.test?subject=CPT%201%3A%20late%20work');
    expect(mailtoFor(row({ title: 'Unit 1 test' }), 'makeUps')).toBe('mailto:ada@example.test?subject=Unit%201%20test%3A%20make-up%20test');
    expect(mailtoFor(row({ title: 'A & B' }), 'resubmissions')).toBe('mailto:ada@example.test?subject=A%20%26%20B%3A%20resubmission');
  });
  it('null without an email', () => {
    expect(mailtoFor(row({ studentEmail: null }), 'late')).toBeNull();
    expect(mailtoFor(row({ studentEmail: '  ' }), 'late')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `cd client && npx vitest run src/lib/emailLists.test.js`
Expected: FAIL, because `./emailLists.js` can't be resolved.

- [ ] **Step 3: Implement.** Create `client/src/lib/emailLists.js`:

```js
// Pure helpers for the triage panels' email actions (#137): who a panel's "@" menu
// copies, the Outlook-ready address string ("a@x; b@x"), and a row's mailto: link.
// kind: 'makeUps' | 'late' | 'resubmissions'.

const KIND_WORDS = { makeUps: 'make-up test', late: 'late work', resubmissions: 'resubmission' };

// Students who still owe something: everyone who missed a make-up; late work not yet
// handed in (a submitted-late row is listed for referral, not chasing); resubmissions
// still awaited (an arrived one is the teacher's turn).
export function stillOwing(kind, row) {
  if (kind === 'late') return row.kind !== 'submitted_late';
  if (kind === 'resubmissions') return row.state !== 'arrived';
  return true;
}

// One menu item: distinct students in `rows`, their addresses, and how many have none.
function menuItem(key, label, rows) {
  const byStudent = new Map();
  for (const r of rows) {
    if (!byStudent.has(r.studentId)) byStudent.set(r.studentId, (r.studentEmail || '').trim() || null);
  }
  const emails = [...byStudent.values()].filter(Boolean);
  return { key, label, students: byStudent.size, emails, missing: byStudent.size - emails.length };
}

const TIERS = [
  { key: 'red', label: 'Red', tones: ['red'] },
  { key: 'redAmber', label: 'Red + amber', tones: ['red', 'amber'] },
  { key: 'all', label: 'Everyone still owing', tones: null },
];

// Tiers narrow → broad, each dropped when empty or the same size as the tier kept
// before it (nested sets, so same size = same students). By assessment only when
// more than one assessment is involved; the block tells two sections apart on the
// all-courses view.
export function buildEmailMenu(kind, rows, { showCourse = false } = {}) {
  const owing = (rows || []).filter((r) => stillOwing(kind, r));
  const tiers = [];
  for (const t of TIERS) {
    const item = menuItem(t.key, t.label, t.tones ? owing.filter((r) => t.tones.includes(r.tone)) : owing);
    if (item.students === 0 || item.students === tiers.at(-1)?.students) continue;
    tiers.push(item);
  }
  const groups = new Map();
  for (const r of owing) {
    if (!groups.has(r.assignmentId)) groups.set(r.assignmentId, []);
    groups.get(r.assignmentId).push(r);
  }
  const byAssessment = groups.size < 2 ? [] : [...groups.entries()]
    .map(([id, rs]) => {
      const block = showCourse && rs[0].blockNumber ? ` · BK ${rs[0].blockNumber}` : '';
      return menuItem(`a${id}`, `${rs[0].title}${block}`, rs);
    })
    .sort((x, y) => y.students - x.students || x.label.localeCompare(y.label));
  return { tiers, byAssessment };
}

export function uniqueAddresses(emails) {
  const seen = new Set();
  const out = [];
  for (const e of emails || []) {
    const v = (e || '').trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}

export const formatAddresses = (emails) => uniqueAddresses(emails).join('; ');

export function copiedMessage(count, missing = 0) {
  const none = missing > 0 ? `${missing} student${missing === 1 ? ' has' : 's have'} no email in Prism.` : '';
  if (count === 0) return `Nothing copied: ${none}`;
  const base = `${count} address${count === 1 ? '' : 'es'} copied. Paste into Outlook To or Bcc.`;
  return none ? `${base} ${none}` : base;
}

export function mailtoFor(row, kind) {
  const email = (row.studentEmail || '').trim();
  if (!email) return null;
  return `mailto:${email}?subject=${encodeURIComponent(`${row.title}: ${KIND_WORDS[kind]}`)}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `cd client && npx vitest run src/lib/emailLists.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit.**

```bash
git add client/src/lib/emailLists.js client/src/lib/emailLists.test.js
git commit -m "feat(triage): emailLists helpers for copy-emails menus and mailto links (#137)"
```

---

### Task 3: `EmailMenu` + `MailLink` components

**Files:**
- Create: `client/src/components/triage/EmailMenu.jsx`
- Modify: `client/src/app.css` (new rules directly after the `.triage-row--history .triage-row__text { ... }` rule in the triage block, NOT in the phone block)
- Test: `client/src/components/triage/EmailMenu.test.jsx`

**Interfaces:**
- Consumes: `buildEmailMenu`, `uniqueAddresses`, `copiedMessage` and `mailtoFor` from `client/src/lib/emailLists.js` (Task 2).
- Produces:
  - `default export EmailMenu({ kind, rows, showCourse = false })`: renders `null` when nobody still owes.
  - `export function MailLink({ row, kind })`: a ✉ `<a>` with `aria-label="Email {studentName}"`, or `null` without an email.

- [ ] **Step 1: Write the failing tests.** Create `client/src/components/triage/EmailMenu.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import EmailMenu, { MailLink } from './EmailMenu.jsx';

const ROWS = [
  { studentId: 1, studentName: 'Ada L', studentEmail: 'a@example.test', tone: 'red', kind: 'outstanding', assignmentId: 9, title: 'CPT 1' },
  { studentId: 2, studentName: 'Bo M', studentEmail: 'B@example.test', tone: 'amber', kind: 'outstanding', assignmentId: 10, title: 'Unit 2 quiz' },
  { studentId: 3, studentName: 'Cy N', studentEmail: null, tone: 'green', kind: 'outstanding', assignmentId: 9, title: 'CPT 1' },
  { studentId: 4, studentName: 'Di O', studentEmail: 'd@example.test', tone: 'red', kind: 'submitted_late', assignmentId: 9, title: 'CPT 1' },
];

let writeText;
function setClipboard(impl) {
  writeText = impl;
  Object.defineProperty(navigator, 'clipboard', { value: impl ? { writeText: impl } : undefined, configurable: true });
}
const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Copy student emails' }));
const pick = async (name) => {
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name })); });
};

beforeEach(() => { setClipboard(vi.fn().mockResolvedValue(undefined)); });
afterEach(() => { vi.useRealTimers(); });

describe('EmailMenu', () => {
  it('renders nothing when nobody still owes', () => {
    const { container } = render(<EmailMenu kind="late" rows={[ROWS[3]]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('"@ ▾" button opens a menu of tiers then assessments, with counts', () => {
    render(<EmailMenu kind="late" rows={ROWS} />);
    const btn = screen.getByRole('button', { name: 'Copy student emails' });
    expect(btn).toHaveTextContent('@ ▾');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    openMenu();
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('menuitem').map((el) => el.textContent)).toEqual([
      'Red (1)', 'Red + amber (2)', 'Everyone still owing (3)', 'CPT 1 (2)', 'Unit 2 quiz (1)',
    ]);
    expect(screen.getByText('By assessment')).toBeInTheDocument();
  });

  it('copies "; "-joined addresses and says how many, noting students with no email', async () => {
    render(<EmailMenu kind="late" rows={ROWS} />);
    openMenu();
    await pick('Everyone still owing (3)');
    expect(writeText).toHaveBeenCalledWith('a@example.test; B@example.test');
    expect(screen.getByRole('status')).toHaveTextContent(
      '2 addresses copied. Paste into Outlook To or Bcc. 1 student has no email in Prism.',
    );
    expect(screen.queryByRole('menu')).not.toBeInTheDocument(); // closes on choice
  });

  it('the status clears after a few seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(<EmailMenu kind="late" rows={ROWS} />);
    openMenu();
    await pick('Red (1)');
    expect(screen.getByRole('status')).toHaveTextContent('1 address copied.');
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByRole('status')).toBeEmptyDOMElement(); // toHaveTextContent('') would match anything
  });

  it('copies nothing when no chosen student has an email, and says so', async () => {
    render(<EmailMenu kind="late" rows={[ROWS[2]]} />);
    openMenu();
    await pick('Everyone still owing (1)');
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Nothing copied: 1 student has no email in Prism.');
  });

  it('falls back to a selected field when the clipboard rejects', async () => {
    setClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    render(<EmailMenu kind="late" rows={ROWS} />);
    openMenu();
    await pick('Red + amber (2)');
    const field = screen.getByLabelText('Addresses to copy');
    expect(field).toHaveValue('a@example.test; B@example.test');
    expect(field).toHaveAttribute('readonly');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByLabelText('Addresses to copy')).not.toBeInTheDocument();
  });

  it('falls back when there is no clipboard API at all', async () => {
    setClipboard(null);
    render(<EmailMenu kind="late" rows={ROWS} />);
    openMenu();
    await pick('Red (1)');
    expect(screen.getByLabelText('Addresses to copy')).toHaveValue('a@example.test');
  });

  it('Escape and an outside click close the menu', () => {
    render(<div><p>outside</p><EmailMenu kind="late" rows={ROWS} /></div>);
    openMenu();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy student emails' })).toHaveFocus();
    openMenu();
    fireEvent.mouseDown(screen.getByText('outside'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

describe('MailLink', () => {
  it('links to a prefilled mailto', () => {
    render(<MailLink row={ROWS[0]} kind="late" />);
    expect(screen.getByRole('link', { name: 'Email Ada L' }))
      .toHaveAttribute('href', 'mailto:a@example.test?subject=CPT%201%3A%20late%20work');
  });
  it('renders nothing without an email', () => {
    const { container } = render(<MailLink row={ROWS[2]} kind="late" />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `cd client && npx vitest run src/components/triage/EmailMenu.test.jsx`
Expected: FAIL, because `./EmailMenu.jsx` can't be resolved.

- [ ] **Step 3: Implement.** Create `client/src/components/triage/EmailMenu.jsx`:

```jsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildEmailMenu, uniqueAddresses, copiedMessage, mailtoFor } from '../../lib/emailLists.js';

// "@ ▾" in a triage panel header (#137): copies the addresses of students who still
// owe something, by urgency tier or by assessment, as "a@x; b@x" for Outlook's To or
// Bcc. "@" = copy addresses; the row's ✉ (MailLink) = write one email. The menu, the
// "copied" status and the copy-by-hand fallback (no clipboard, or it refused) float
// below the button. Rows are the panel's whole list, not just the visible five.
const STATUS_MS = 5000;

export default function EmailMenu({ kind, rows, showCourse = false }) {
  const menu = useMemo(() => buildEmailMenu(kind, rows, { showCourse }), [kind, rows, showCourse]);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState('');
  const [fallback, setFallback] = useState(null); // the address string to copy by hand
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const fieldRef = useRef(null);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  useEffect(() => { if (fallback) fieldRef.current?.select(); }, [fallback]);

  if (menu.tiers.length === 0) return null;

  function say(text) {
    setStatus(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(''), STATUS_MS);
  }

  async function copy(item) {
    setOpen(false);
    setFallback(null);
    const addresses = uniqueAddresses(item.emails);
    if (addresses.length === 0) { say(copiedMessage(0, item.missing)); return; }
    const text = addresses.join('; ');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('No clipboard');
      await navigator.clipboard.writeText(text);
      say(copiedMessage(addresses.length, item.missing));
    } catch {
      clearTimeout(timer.current);
      setStatus('');
      setFallback(text);
    }
  }

  const itemButton = (item) => (
    <button key={item.key} type="button" role="menuitem" className="ghost email-menu__item" onClick={() => copy(item)}>
      {item.label} ({item.students})
    </button>
  );

  return (
    <div className="email-menu" ref={wrapRef}>
      <button
        ref={buttonRef} type="button" className="ghost accent triage-panel__more"
        aria-label="Copy student emails" title="Copy student emails"
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}
      >
        @ ▾
      </button>
      {open && (
        <div className="email-menu__pop" role="menu" aria-label="Copy student emails">
          {menu.tiers.map(itemButton)}
          {menu.byAssessment.length > 0 && (
            <>
              <div className="email-menu__group" role="presentation">By assessment</div>
              {menu.byAssessment.map(itemButton)}
            </>
          )}
        </div>
      )}
      <p className="email-menu__status" role="status">{status}</p>
      {fallback && (
        <div className="email-menu__bubble">
          <span>Copy these addresses:</span>
          <input
            ref={fieldRef} readOnly value={fallback} aria-label="Addresses to copy"
            className="email-menu__field" onFocus={(e) => e.target.select()}
          />
          <button type="button" className="ghost" onClick={() => setFallback(null)}>Close</button>
        </div>
      )}
    </div>
  );
}

// A row's ✉: opens the mail app to that one student, subject prefilled.
export function MailLink({ row, kind }) {
  const href = mailtoFor(row, kind);
  if (!href) return null;
  const label = `Email ${row.studentName}`;
  return <a className="triage-row__mail" href={href} aria-label={label} title={label}>✉</a>;
}
```

In `client/src/app.css`, directly after the `.triage-row--history .triage-row__text { ... }` rule, add:

```css
/* Email menu (#137): "@ ▾" in a panel header copies student addresses; its menu,
   the "copied" status and the copy-by-hand fallback float below the button,
   right-aligned so they stay inside the 380px rail. ✉ on a row = mailto:. */
.email-menu { position: relative; }
.email-menu__pop,
.email-menu__status,
.email-menu__bubble {
  position: absolute; right: 0; top: calc(100% + 4px); z-index: 20;
  background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 8px;
  box-shadow: var(--card-shadow-hover);
}
.email-menu__pop { min-width: 14rem; padding: 0.3rem; display: flex; flex-direction: column; }
button.email-menu__item { text-align: left; padding: 0.35rem 0.5rem; font-size: 0.8rem; white-space: nowrap; }
.email-menu__group {
  margin-top: 0.2rem; padding: 0.4rem 0.5rem 0.15rem; border-top: 1px solid var(--border);
  font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted);
}
.email-menu__status { margin: 0; padding: 0.45rem 0.6rem; width: max-content; max-width: 18rem; font-size: 0.75rem; color: var(--text); }
.email-menu__status:empty { display: none; }
.email-menu__bubble { width: 18rem; padding: 0.5rem 0.6rem; display: flex; flex-direction: column; gap: 0.35rem; font-size: 0.75rem; }
.email-menu__field { width: 100%; box-sizing: border-box; font-size: 0.75rem; }
.triage-row__mail { flex-shrink: 0; font-size: 0.8rem; line-height: 1; color: var(--text-muted); text-decoration: none; }
.triage-row__mail:hover { color: var(--accent); }
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `cd client && npx vitest run src/components/triage/EmailMenu.test.jsx`
Expected: all PASS.

- [ ] **Step 5: Commit.**

```bash
git add client/src/components/triage/EmailMenu.jsx client/src/components/triage/EmailMenu.test.jsx client/src/app.css
git commit -m "feat(triage): EmailMenu (@ copy addresses) and MailLink (mailto) components (#137)"
```

---

### Task 4: Wire the menu, row links and panel ids into the triage panels

**Files:**
- Modify: `client/src/components/triage/panelParts.jsx` (`PanelHead`: heading `tabIndex={-1}`)
- Modify: `client/src/components/triage/MakeUpPanel.jsx`
- Modify: `client/src/components/triage/LateWorkPanel.jsx`
- Modify: `client/src/components/triage/ResubmissionsPanel.jsx`
- Modify: `client/src/components/triage/FeedbackOwedPanel.jsx` (id only)
- Test: `client/src/components/triage/TriageSection.test.jsx`

**Interfaces:**
- Consumes: `EmailMenu` and `MailLink` from `./EmailMenu.jsx` (Task 3). The rows' `studentEmail` (Task 1).
- Produces: the panel `<section>` ids `triage-makeups`, `triage-late`, `triage-resubmissions` and `triage-feedback`. Each panel's `<h3>` is focusable by script (`tabIndex={-1}`). Task 5 relies on both.

- [ ] **Step 1: Write the failing tests.** Append to `client/src/components/triage/TriageSection.test.jsx`, inside the file but after the existing `describe('TriageSection', ...)` block. It uses the file's `PAYLOAD`, `renderSection`, `latePanel` and `api`:

```jsx
describe('TriageSection — email (#137)', () => {
  const withEmails = (rows) => rows.map((r) => ({ ...r, studentEmail: `s${r.studentId}@example.test` }));
  const EMAIL_PAYLOAD = {
    ...PAYLOAD,
    lateWork: withEmails(PAYLOAD.lateWork),
    makeUps: withEmails(PAYLOAD.makeUps),
    resubmissions: [
      { id: 31, state: 'waiting', studentId: 11, studentName: 'Ivy Ho', studentEmail: 's11@example.test', courseId: 5, courseName: 'AP CSP', assignmentId: 9, schoologyAssignmentId: 'a9', title: 'CP2', day: 2, limit: 4, tone: 'green', approx: false, lessons: 3, until: '2026-10-20', source: 'app' },
      { id: null, state: 'arrived', studentId: 12, studentName: 'Jo Ko', studentEmail: 's12@example.test', courseId: 5, courseName: 'AP CSP', assignmentId: 9, schoologyAssignmentId: 'a9', title: 'CP2', day: 1, limit: 10, tone: 'green', approx: false },
    ],
  };
  beforeEach(() => {
    api.getTriage.mockResolvedValue(EMAIL_PAYLOAD);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
  });

  it('panels carry stable ids for the Dashboard tiles', async () => {
    renderSection();
    await screen.findByText('Maya Chen');
    expect(screen.getByLabelText('Make-up tests')).toHaveAttribute('id', 'triage-makeups');
    expect(screen.getByLabelText('Late work')).toHaveAttribute('id', 'triage-late');
    expect(screen.getByLabelText('Resubmissions')).toHaveAttribute('id', 'triage-resubmissions');
    expect(screen.getByLabelText('Feedback owed')).toHaveAttribute('id', 'triage-feedback');
    expect(within(screen.getByLabelText('Late work')).getByRole('heading', { level: 3 })).toHaveAttribute('tabindex', '-1');
  });

  it('three panels get the @ menu; Feedback owed does not', async () => {
    renderSection();
    await screen.findByText('Maya Chen');
    for (const name of ['Make-up tests', 'Late work', 'Resubmissions']) {
      expect(within(screen.getByLabelText(name)).getByRole('button', { name: 'Copy student emails' })).toBeInTheDocument();
    }
    expect(within(screen.getByLabelText('Feedback owed')).queryByRole('button', { name: 'Copy student emails' })).not.toBeInTheDocument();
  });

  it('Late work menu skips submitted-late rows; Resubmissions menu skips arrived rows', async () => {
    renderSection();
    const late = await latePanel();
    fireEvent.click(within(late).getByRole('button', { name: 'Copy student emails' }));
    // Maya (red, outstanding) + Aiden (green, outstanding); Ethan submitted late → excluded.
    expect(within(late).getAllByRole('menuitem').map((el) => el.textContent))
      .toEqual(['Red (1)', 'Everyone still owing (2)', 'CP2 (1)', 'CP2 · BK 7 (1)']);
    const resub = screen.getByLabelText('Resubmissions');
    fireEvent.click(within(resub).getByRole('button', { name: 'Copy student emails' }));
    expect(within(resub).getAllByRole('menuitem').map((el) => el.textContent)).toEqual(['Everyone still owing (1)']);
  });

  it('copies every listed student, including rows beyond the 5-row limit', async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      ...PAYLOAD.lateWork[0], studentId: 100 + i, studentName: `Student ${i}`, studentEmail: `p${i}@example.test`,
    }));
    api.getTriage.mockResolvedValue({ ...EMAIL_PAYLOAD, lateWork: many });
    renderSection();
    const late = await latePanel();
    await within(late).findByText('Student 0');
    expect(within(late).queryByText('Student 6')).not.toBeInTheDocument(); // hidden behind "All 7"
    fireEvent.click(within(late).getByRole('button', { name: 'Copy student emails' }));
    await act(async () => { fireEvent.click(within(late).getByRole('menuitem', { name: 'Red (7)' })); });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(many.map((r) => r.studentEmail).join('; '));
  });

  it('every row, including arrived and submitted-late, gets a ✉ mailto link', async () => {
    renderSection();
    await screen.findByText('Maya Chen');
    expect(screen.getByRole('link', { name: 'Email Ethan Wong' }))
      .toHaveAttribute('href', 'mailto:s2@example.test?subject=CP2%3A%20late%20work');
    expect(screen.getByRole('link', { name: 'Email Noah Park' }))
      .toHaveAttribute('href', 'mailto:s7@example.test?subject=Unit%201%20test%3A%20make-up%20test');
    expect(screen.getByRole('link', { name: 'Email Jo Ko' }))
      .toHaveAttribute('href', 'mailto:s12@example.test?subject=CP2%3A%20resubmission');
  });

  it('no ✉ on a row without an email', async () => {
    api.getTriage.mockResolvedValue(PAYLOAD); // no studentEmail anywhere
    renderSection();
    await screen.findByText('Maya Chen');
    expect(screen.queryByRole('link', { name: /^Email / })).not.toBeInTheDocument();
  });
});
```

Add `act` to the file's existing `@testing-library/react` import, which becomes `import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';`.

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `cd client && npx vitest run src/components/triage/TriageSection.test.jsx -t "email"`
Expected: the new tests FAIL (no ids, no `Copy student emails` button, no ✉ links).

- [ ] **Step 3: Implement.**

`panelParts.jsx`: in `PanelHead`, give the heading `tabIndex={-1}` (the stats tiles focus it):

```jsx
      <h3 className="triage-panel__title" tabIndex={-1}>{title} {badge}</h3>
```

`MakeUpPanel.jsx`:
- Add `import EmailMenu, { MailLink } from './EmailMenu.jsx';`
- `<section className="card triage-panel" aria-label="Make-up tests">` becomes `<section className="card triage-panel" id="triage-makeups" aria-label="Make-up tests">`.
- Inside `PanelHead`, put `<EmailMenu kind="makeUps" rows={rows} showCourse={showCourse} />` before `<ShowAllToggle ... />`.
- After the name `<Link ...>{r.studentName}</Link>` in `.triage-row__line`, add `<MailLink row={r} kind="makeUps" />`.

`LateWorkPanel.jsx`:
- Add `import EmailMenu, { MailLink } from './EmailMenu.jsx';`
- `id="triage-late"` on the `<section>`.
- `<EmailMenu kind="late" rows={rows} showCourse={showCourse} />` before `<ShowAllToggle ... />`.
- `<MailLink row={r} kind="late" />` right after the name `<Link>`.

`ResubmissionsPanel.jsx`:
- Add `import EmailMenu, { MailLink } from './EmailMenu.jsx';`
- `id="triage-resubmissions"` on the `<section>`.
- `<EmailMenu kind="resubmissions" rows={rows} showCourse={showCourse} />` before `<ShowAllToggle ... />`.
- `<MailLink row={r} kind="resubmissions" />` right after the name `<Link>`, before the arrived/by badge.

`FeedbackOwedPanel.jsx`: `id="triage-feedback"` on the `<section>` only.

Update the comment above each panel's default export with one line: `"@ ▾" (EmailMenu) copies still-owing students' addresses; ✉ (MailLink) on each row opens a mailto.` Use "Ids are fixed (triage-feedback) for the Dashboard stats tiles." for Feedback owed.

- [ ] **Step 4: Run the whole triage + course page suites to verify they pass.**

Run: `cd client && npx vitest run src/components/triage src/pages/CoursePage.makeUps.test.jsx src/pages/CoursePage.test.jsx`
Expected: all PASS. An older test may break because it counts buttons or links, or expects exact header children. If so, fix the test only if the new element is the cause, and note it in the commit message.

- [ ] **Step 5: Commit.**

```bash
git add client/src/components/triage
git commit -m "feat(triage): @ copy-emails menu and ✉ row links on make-ups, late work, resubmissions (#137)"
```

---

### Task 5: Dashboard stats strip

**Files:**
- Create: `client/src/components/triage/StatsStrip.jsx`
- Modify: `client/src/pages/Dashboard.jsx`
- Modify: `client/src/app.css` (strip rules after the Task 3 email-menu rules, plus one rule inside the `PHONE LAYOUT` block)
- Test: `client/src/pages/Dashboard.test.jsx`

**Interfaces:**
- Consumes:
  - From Task 4: the panel ids and the focusable `<h3>`.
  - `useSchoologyConnection()` from `client/src/components/SchoologyConnectionStatus.jsx`. It returns `{ status: { live: 'connected'|'expired'|'unknown'|'none'|null, ... } | null }`.
  - `triage.counts.{atReferralLimit, makeUpsOverdue, resubmissionsOverdue, feedbackOverdue}`, `triage.calendar`, and `syncStatus.last.{completed_at, started_at, status}`.
- Produces: `default export StatsStrip({ triage, syncStatus })`. Also `export const TILES` and `export function jumpTo(panelId)`.

- [ ] **Step 1: Write the failing tests.** In `client/src/pages/Dashboard.test.jsx`:

Add `getMasteryLoginStatus: vi.fn(),` to the `vi.mock('../services/api.js', ...)` object. In the top-level `beforeEach`, add `api.getMasteryLoginStatus.mockResolvedValue({ loggedIn: true, live: 'connected' });`. Add `within` to the `@testing-library/react` import. Then append:

```jsx
describe('Dashboard — stats strip (#137)', () => {
  const TRIAGE = {
    settings: { referralLimitDays: 8, feedbackLimitDays: 10, warnLeadDays: 3, showFormativeDefault: false, makeUpAmberDay: 2, makeUpRedDay: 4 },
    includeFormative: false, historyCount: 0, lastSyncAt: null, makeUpsUnchecked: 0,
    calendar: { source: 'powerschool', totalSchoolDays: 164, today: { schoolDayNumber: 35, cycleLetter: 'A' } },
    counts: { atReferralLimit: 2, makeUpsOverdue: 0, resubmissionsOverdue: 1, feedbackOverdue: 3 },
    lateWork: [{ kind: 'outstanding', studentId: 1, studentName: 'Maya Chen', courseId: 5, courseName: 'AP CSP', assignmentId: 9, schoologyAssignmentId: 'a9', title: 'CP2', dueDate: '2026-10-05', daysLate: 9, day: 10, tone: 'red', approx: false }],
    feedbackOwed: [], makeUps: [], resubmissions: [],
  };
  beforeEach(() => {
    api.getCoursesByView.mockResolvedValue([{ id: 5, course_name: 'AP CSP', grading_period: 'Semester 1: 08/14/2026 - 01/11/2027' }]);
    api.getTriage.mockResolvedValue(TRIAGE);
    api.getSyncStatus.mockResolvedValue({ last: { completed_at: '2026-10-04 07:12:00', status: 'success' } });
  });
  const strip = () => screen.findByRole('region', { name: 'At a glance' });

  it('shows four tiles with their counts; red when above 0', async () => {
    const s = await strip();
    const tile = (label) => within(s).getByRole('button', { name: new RegExp(label) });
    await within(s).findByRole('button', { name: /At referral limit/ });
    expect(tile('At referral limit')).toHaveTextContent('2');
    expect(tile('At referral limit')).toHaveClass('stat-tile--red');
    expect(tile('Make-ups overdue')).toHaveTextContent('0');
    expect(tile('Make-ups overdue')).not.toHaveClass('stat-tile--red');
    expect(tile('Resubmissions overdue')).toHaveTextContent('1');
    expect(tile('Feedback overdue')).toHaveTextContent('3');
  });

  it('a tile scrolls its panel into view and focuses the panel heading', async () => {
    const s = await strip();
    await screen.findByText('Maya Chen');
    const panel = document.getElementById('triage-late');
    panel.scrollIntoView = vi.fn();
    fireEvent.click(await within(s).findByRole('button', { name: /At referral limit/ }));
    expect(panel.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    expect(within(panel).getByRole('heading', { level: 3 })).toHaveFocus();
  });

  it('a tile whose panel is not rendered does nothing', async () => {
    const s = await strip();
    await screen.findByText('Maya Chen');
    expect(document.getElementById('triage-resubmissions')).toBeNull(); // empty Resubmissions hides itself
    expect(() => fireEvent.click(within(s).getByRole('button', { name: /Resubmissions overdue/ }))).not.toThrow();
  });

  it('status line: school day, last sync, Schoology connection', async () => {
    const s = await strip();
    expect(within(s).getByText('School day 35 of 164 · Day A')).toBeInTheDocument();
    expect(within(s).getByText(/^Last sync .*, success$/)).toBeInTheDocument();
    expect(await within(s).findByText('Schoology: connected')).toBeInTheDocument();
    expect(screen.queryByText(/Last sync: /)).not.toBeInTheDocument(); // the old standalone line is gone
  });

  it('an expired Schoology connection links to Settings', async () => {
    api.getMasteryLoginStatus.mockResolvedValue({ loggedIn: true, live: 'expired' });
    const s = await strip();
    expect(await within(s).findByRole('link', { name: 'Schoology: expired' })).toHaveAttribute('href', '/settings#schoology');
  });

  it('no strip on the Archived tab', async () => {
    await strip();
    fireEvent.click(screen.getByText('Archived'));
    expect(screen.queryByRole('region', { name: 'At a glance' })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `cd client && npx vitest run src/pages/Dashboard.test.jsx`
Expected: the new `stats strip` tests FAIL (there is no "At a glance" region yet). The existing tests still pass.

- [ ] **Step 3: Implement.** Create `client/src/components/triage/StatsStrip.jsx`:

```jsx
import { Link } from 'react-router-dom';
import { useSchoologyConnection } from '../SchoologyConnectionStatus.jsx';
import { formatDateTime } from '../../lib/formatDate.js';

// Dashboard "At a glance" strip (#137): one status line (school day, last sync,
// Schoology connection) above four overdue tiles from the triage payload's counts.
// A tile scrolls to its triage panel and focuses the panel heading; a panel that
// isn't rendered (an empty Resubmissions panel hides itself) makes it a no-op.
export const TILES = [
  { key: 'atReferralLimit', label: 'At referral limit', panel: 'triage-late' },
  { key: 'makeUpsOverdue', label: 'Make-ups overdue', panel: 'triage-makeups' },
  { key: 'resubmissionsOverdue', label: 'Resubmissions overdue', panel: 'triage-resubmissions' },
  { key: 'feedbackOverdue', label: 'Feedback overdue', panel: 'triage-feedback' },
];

const SCHOOLOGY_TEXT = { connected: 'connected', expired: 'expired', unknown: 'unknown', none: 'not set up' };

export function jumpTo(panelId) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  panel.querySelector('h3')?.focus({ preventScroll: true });
}

export default function StatsStrip({ triage, syncStatus }) {
  const { status } = useSchoologyConnection();
  const today = triage?.calendar?.today;
  const last = syncStatus?.last;
  const live = status?.live;

  const parts = [];
  if (today?.schoolDayNumber) {
    const cycle = today.cycleLetter ? ` · Day ${today.cycleLetter}` : '';
    parts.push(<span key="day">{`School day ${today.schoolDayNumber} of ${triage.calendar.totalSchoolDays}${cycle}`}</span>);
  }
  if (last) {
    parts.push(<span key="sync">{`Last sync ${formatDateTime(last.completed_at || last.started_at)}, ${last.status}`}</span>);
  }
  if (SCHOOLOGY_TEXT[live]) {
    const text = `Schoology: ${SCHOOLOGY_TEXT[live]}`;
    parts.push(live === 'expired'
      ? <Link key="schoology" to="/settings#schoology">{text}</Link>
      : <span key="schoology">{text}</span>);
  }
  const counts = triage?.counts;
  if (parts.length === 0 && !counts) return null;

  return (
    <section className="stats-strip" aria-label="At a glance">
      {parts.length > 0 && (
        <p className="text-sm text-muted stats-strip__status">
          {parts.flatMap((p, i) => (i ? [<span key={`sep${i}`} aria-hidden="true"> · </span>, p] : [p]))}
        </p>
      )}
      {counts && (
        <div className="stats-strip__tiles">
          {TILES.map((t) => {
            const n = counts[t.key] ?? 0;
            return (
              <button key={t.key} type="button" className={`stat-tile${n > 0 ? ' stat-tile--red' : ''}`} onClick={() => jumpTo(t.panel)}>
                <span className="stat-tile__num">{n}</span>
                <span className="stat-tile__label">{t.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
```

In `client/src/pages/Dashboard.jsx`:
- Add `import StatsStrip from '../components/triage/StatsStrip.jsx';`
- Remove the header's school-day `<span>` (the `{triage?.calendar?.today?.schoolDayNumber && (...)}` block). The header keeps only the title.
- Remove the `{/* Sync status */}` paragraph block (the `Last sync:` line with the em dash). `formatDateTime` is then unused in Dashboard.jsx, so remove its import.
- Directly before `{activeTab === 'current' && (<div className="triage-layout">`, add:

```jsx
      {activeTab === 'current' && <StatsStrip triage={triage} syncStatus={syncStatus} />}
```

In `client/src/app.css`, after the Task 3 email-menu rules, add:

```css
/* Dashboard stats strip (#137): a status line, then four overdue tiles that jump
   to their triage panel. Red tile = something overdue; muted 0 = clear. */
.stats-strip { margin-bottom: 1.25rem; }
.stats-strip__status { margin: 0 0 0.6rem; }
.stats-strip__tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.75rem; }
button.stat-tile {
  display: flex; flex-direction: column; align-items: flex-start; gap: 0.15rem;
  padding: 0.7rem 0.9rem; text-align: left; cursor: pointer; font: inherit;
  background: var(--card-bg); color: var(--text);
  border: 1px solid var(--card-border); border-radius: 12px; box-shadow: var(--card-shadow);
}
button.stat-tile:hover { box-shadow: var(--card-shadow-hover); }
.stat-tile__num { font-size: 1.6rem; font-weight: 700; line-height: 1.1; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.stat-tile__label { font-size: 0.78rem; color: var(--text-muted); }
button.stat-tile--red { border-color: var(--danger); }
.stat-tile--red .stat-tile__num { color: var(--danger); }
```

Inside the `PHONE LAYOUT` `@media (max-width: 768px)` block at the end of `app.css`, after the triage one-column rules, add:

```css
  /* Stats strip: tiles 2 x 2. */
  .stats-strip__tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
```

Before moving on, check whether a global `button` rule in `app.css` (e.g. a `button {}` or `button:hover` transform) visibly overrides `.stat-tile`. If one does, add the minimal override to the `button.stat-tile` rule, using variables only.

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `cd client && npx vitest run src/pages/Dashboard.test.jsx src/components/triage`
Expected: all PASS. The existing `'School day 35 of 164 · Day A'` assertion still passes, because the strip renders that exact span.

- [ ] **Step 5: Commit.**

```bash
git add client/src/components/triage/StatsStrip.jsx client/src/pages/Dashboard.jsx client/src/pages/Dashboard.test.jsx client/src/app.css
git commit -m "feat(dashboard): At a glance stats strip, overdue tiles jump to their panel (#137)"
```

---

### Task 6: Full suites, real-browser check, docs

**Files:**
- Modify: `docs/design-language.md` (append a section)
- Modify: `.claude/build-progress.md` (Triage section)

- [ ] **Step 1: Run both full suites and the build.**

Run: `npx vitest run` (repo root, server + mcp), then `cd client && npx vitest run`, then `npm run build`.
Expected: all PASS, and the build succeeds. Fix any failure before continuing. Report the counts.

- [ ] **Step 2: Real-browser check on a dev server (never prod).**

```bash
cp ~/prism/data/students.db /tmp/prism-137.db
PORT=3002 DB_PATH=/tmp/prism-137.db npm run dev   # run in background
npm run check:mobile http://127.0.0.1:3002
```

Then use Playwright to load `http://127.0.0.1:3002/` at 390x844 and at 1280x900 and save PNGs to `/tmp/prism-137-*.png`:
- (a) the Dashboard top with the strip;
- (b) a panel with its `@` menu open;
- (c) the status after a copy (grant the `clipboard-read`/`clipboard-write` permissions to the browser context).

Open each PNG with the Read tool so it shows inline. Don't click Refer, Extend, Grade stands, Publish or any Schoology action. Stop with `PORT=3002 npm run dev:stop`, then confirm no `node --watch`/vite process from this clone is left (`ps aux | grep -E "node --watch|vite" | grep bridge-cse`).

- [ ] **Step 3: Append to `docs/design-language.md`:**

```markdown
## Triage: "@" copies addresses, ✉ writes one email (October 2026, #137)

- **"@ ▾" in a panel header** (Make-up tests, Late work, Resubmissions) copies the addresses of students who still owe something: tiers Red / Red + amber / Everyone still owing, then By assessment. Format `a@x; b@x` for Outlook To or Bcc. Students who already acted (submitted late, resubmission arrived) are left out of the bulk copy. "@" was chosen over the word "Email" because it reads as *addresses* and keeps the header on one line on a phone.
- **✉ on a row** is a `mailto:` to that one student, subject `<title>: late work | make-up test | resubmission`. Course names are not in the subject: the stored Schoology names are long capitals and Prism has no short name.
- **No toast system.** Confirmation is an inline `role="status"` bubble under the button that clears after 5 seconds. If the clipboard is unavailable, a pre-selected read-only field holds the addresses to copy by hand.
- **Dashboard "At a glance" strip:** one muted status line (school day · last sync · Schoology connection, expired links to Settings), then four tiles (At referral limit, Make-ups overdue, Resubmissions overdue, Feedback overdue). Red number + red border when above 0, muted 0 when clear; a tile scrolls to its panel and focuses its heading. 4 across on desktop, 2 x 2 on a phone. It replaces the header's school-day text and the old "Last sync:" line.
```

- [ ] **Step 4: Add a dated entry to the Triage section of `.claude/build-progress.md`.** It covers: `studentEmail` on triage rows (also in MCP `get_triage`), the `@` copy menu + ✉ row links, the Dashboard stats strip, the spec/plan paths, and the deferred items (parents, board/tabs, turnaround).

- [ ] **Step 5: Commit.**

```bash
git add docs/design-language.md .claude/build-progress.md
git commit -m "docs: design-language + build log for triage email menus and stats strip (#137)"
```
