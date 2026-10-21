// The Emergency Contact List (#66): PowerTeacher's `/teachers/StudEmgContacts.html?sectionid=`,
// one HTML table per section, header `Student | Guardian 1 | G1 Email | G1 Phone | G1 Faculty |
// Guardian 2 | G2 Email | G2 Phone | G2 Faculty`, one row per student, guardian names as
// `Last, First`. Probed 21/10/2026 (docs/superpowers/specs/2026-10-21-do-not-contact-guardians-design.md).
// It is the map from a student to PowerSchool's two guardian slots; Prism reads only the
// name and email of each slot (the phones and faculty flags are ignored).
const decode = (v) => v
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const text = (html) => decode(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const HEADERS = { student: 'Student', g1Name: 'Guardian 1', g1Email: 'G1 Email', g2Name: 'Guardian 2', g2Email: 'G2 Email' };

// An email cell's first address, lower-cased ("a@x.org; b@x.org" → "a@x.org").
const email = (cell) => (text(cell).split(/[\s;,]+/)[0] || '').toLowerCase() || null;
const name = (cell) => text(cell) || null;

// → [{ student, g1: { name, email }, g2: { name, email } }] in page order. The table is
// the one whose header row holds the five headers above (any order, other columns
// ignored); a layout table before it is skipped. Throws when no row is that header.
export function parseEmergencyContacts(html) {
  const source = String(html || '');
  // Innermost rows only, so a layout table wrapped around the list cannot swallow it.
  const rows = [...source.matchAll(/<tr\b[^>]*>((?:(?!<tr\b)[\s\S])*?)<\/tr>/gi)].map((m) => ({
    end: m.index + m[0].length,
    cells: [...m[1].matchAll(/<(t[dh])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((c) => c[2]),
  }));
  let cols = null;
  let from = -1;
  for (let i = 0; i < rows.length && !cols; i++) {
    const labels = rows[i].cells.map(text);
    const found = Object.fromEntries(Object.entries(HEADERS).map(([key, label]) => [key, labels.indexOf(label)]));
    if (Object.values(found).every((n) => n >= 0)) { cols = found; from = i; }
  }
  if (!cols) throw new Error('emergency contact list: header not found');
  const list = [];
  for (let i = from + 1; i < rows.length; i++) {
    // The table ends before the next row when a </table> sits between them.
    if (/<\/table/i.test(source.slice(rows[i - 1].end, rows[i].end - 1))) break;
    const c = rows[i].cells;
    if (c.length <= Math.max(...Object.values(cols))) continue;
    const student = text(c[cols.student]);
    if (!student) continue;
    list.push({
      student,
      g1: { name: name(c[cols.g1Name]), email: email(c[cols.g1Email]) },
      g2: { name: name(c[cols.g2Name]), email: email(c[cols.g2Email]) },
    });
  }
  return list;
}

// How a row's student cell and a roster `lastfirst` are compared.
const key = (v) => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

// Rows joined to a section's roster by name → Map<studentdcid, { g1, g2 }>. A `lastfirst`
// held by two roster students joins neither: a name cannot say which row is whose.
export function slotsByDcid(rows, roster) {
  const held = new Map();
  for (const s of roster) held.set(key(s.lastfirst), (held.get(key(s.lastfirst)) || 0) + 1);
  const byName = new Map(rows.map((r) => [key(r.student), r]));
  const map = new Map();
  for (const s of roster) {
    const row = byName.get(key(s.lastfirst));
    if (row && held.get(key(s.lastfirst)) === 1) map.set(String(s.studentdcid), { g1: row.g1, g2: row.g2 });
  }
  return map;
}
