// PowerTeacher's student Demographics screen (#191): `/teachers/studentpages/demo.html`, one HTML page per
// student, rows `<tr><td><strong>{label}</strong></td><td>{value}</td></tr>` (#116). Probed 28/10/2026 (formats
// only, .claude/powerschool-api-reference.md "Date of birth"): DOB `MM/DD/YYYY` (the only order that agrees with
// the Age row), Graduation Year 4 digits, Home Room a teacher's name "Last, First", Guardianship present and
// usually empty, Student number the student's number (the local part of their school email, 3 of 3).
// Prism keeps only the date of birth, the graduation year, the home room and the guardianship note; the page's
// other rows (address, phones, parents' names, ethnicity...) are never stored. Address waits until Prism's
// server is on campus (Graham, 28/10/2026).
const decode = (v) => v
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const text = (html) => decode(String(html).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const LABELS = ['DOB', 'Graduation Year', 'Home Room', 'Guardianship', 'Student number'];

// 'MM/DD/YYYY' → 'YYYY-MM-DD', or null when it is not a real date.
export function isoFromUsDate(v) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(v || '').trim());
  if (!m) return null;
  const [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

// The page → { found, dateOfBirth: 'YYYY-MM-DD' | null, graduationYear: number | null, homeRoom, guardianship,
// studentNumber } (text or null). `found` is false when the page has none of these rows (not a Demographics page).
export function parseDemographics(html) {
  const rows = new Map();
  const page = String(html || '').replace(/<script[\s\S]*?<\/script>/gi, '');
  for (const [, row] of page.matchAll(/<tr\b[^>]*>((?:(?!<tr\b)[\s\S])*?)<\/tr>/gi)) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length < 2) continue;
    const label = text(cells[0]);
    if (LABELS.includes(label) && !rows.has(label)) rows.set(label, text(cells[1]) || null);
  }
  const year = /^\d{4}$/.test(rows.get('Graduation Year') || '') ? Number(rows.get('Graduation Year')) : null;
  return {
    found: rows.size > 0,
    dateOfBirth: isoFromUsDate(rows.get('DOB')),
    graduationYear: year,
    homeRoom: rows.get('Home Room') ?? null,
    guardianship: rows.get('Guardianship') ?? null,
    studentNumber: rows.get('Student number') ?? null,
  };
}
