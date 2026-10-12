// Text helpers for linked quizzes. normalizeStem is the comparison key used to
// match a question across copies of a test (copies get new question ids). It is
// ported from csp-tools' build_theory_test_review.py `norm`: tags out, entities
// decoded, then only [a-z0-9] kept, so the HTML and the plain export of one
// question give the same key and the code arrow drops out on both sides.
import { parse } from 'node-html-parser';

export function plainText(html) {
  const withBreaks = String(html ?? '').replace(/<br\s*\/?>/gi, ' ');
  return parse(withBreaks).text.replace(/\s+/g, ' ').trim();
}

export function normalizeStem(html) {
  return plainText(html).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export const optionLetter = (index) => String.fromCharCode(65 + index);

// Schoology's results pages print "10/09/26 8:51am" (US month first, 2-digit year,
// no time zone: the school's display zone). → 'YYYY-MM-DD HH:MM' local, or null.
export function parseUsDateTime(text) {
  const m = String(text ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (!m) return null;
  const [, mo, d, yy, h, min, ap] = m;
  let hour = Number(h) % 12;
  if (ap.toLowerCase() === 'pm') hour += 12;
  const pad = (n) => String(n).padStart(2, '0');
  return `20${yy}-${pad(mo)}-${pad(d)} ${pad(hour)}:${min}`;
}

export function questionFingerprint({ kind, stemHtml, points }) {
  return `${kind}|${normalizeStem(stemHtml)}|${Number(points)}`;
}
