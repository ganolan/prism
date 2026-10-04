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
