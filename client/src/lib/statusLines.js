// client/src/lib/statusLines.js — a mirror of server/lib/statusLines.js (spec Amendment B),
// so the confirm modal can render the default line and compose the preview locally.
// Keep the two identical: statusLines.test.js checks parity against the server module.
// Templates are plain printable ASCII (since 2026-10-03): no special character is ever sent
// to Schoology, so no encoding round-trip can alter a stored line. Prism's own UI may still
// show the ⟳ glyph on its pills and tags.
export function lineDate(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: '2-digit' }).replace(',', '');
}
export const shortDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' });
// The ASCII guarantee for teacher-edited lines: typographic punctuation and odd spaces a
// teacher may type or paste become their plain forms (curly quotes → ' and ", dashes → -,
// … → ..., non-breaking / narrow / tab spaces → space). Anything else outside printable
// ASCII is refused by the server's checkLine ("Use plain characters in the status line").
const PLAIN = [
  [/[\u2018\u2019\u201A\u201B\u2032]/g, "'"],
  [/[\u201C\u201D\u201E\u201F\u2033]/g, '"'],
  [/[\u2010-\u2015\u2212]/g, '-'],
  [/\u2026/g, '...'],
  [/[\t\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' '],
];
export const plainLine = (text) => PLAIN.reduce((t, [re, to]) => t.replace(re, to), String(text ?? ''));
export const isPlainLine = (text) => /^[\x20-\x7E]*$/.test(String(text ?? ''));
const withNote = (text, note) => (note && String(note).trim() ? `${text} ${String(note).trim()}` : text);
export const askLine = ({ until, note }) => withNote(`Resubmission requested - due ${lineDate(until)}.`, note);
export const extendResubmissionLine = ({ until, note }) => withNote(`Resubmission requested - now due ${lineDate(until)}.`, note);
export const gradeStandsLine = ({ until }) => `Resubmission deadline (${lineDate(until)}) passed - your grade stands.`;
export const extensionLine = ({ until, lessons, note }) => withNote(`Extension - now due ${lineDate(until)} (${lessons} ${Number(lessons) === 1 ? 'lesson' : 'lessons'}).`, note);
export const makeUpLine = ({ until, note }) => withNote(`Make-up - sit by ${lineDate(until)}.`, note);
export const receivedLine = ({ on }) => `Resubmission received ${shortDate(on)} - regraded.`;

// Remove the exact stored line from the start (if still there verbatim), then prepend newLine.
export function composeComment(current, storedLine, newLine) {
  // Normalise CRLF → LF first: Schoology can round-trip a comment with CRLF line endings, and
  // without this a stored LF line would never verbatim-match, stacking a duplicate line forever.
  let rest = String(current ?? '').replace(/\r\n/g, '\n');
  // Verbatim match only: the whole comment, or the stored line followed by a newline
  // (so a hand-edited "L1 (edited)" is never mistaken for "L1").
  if (storedLine && (rest === storedLine || rest.startsWith(`${storedLine}\n`))) rest = rest.slice(storedLine.length).replace(/^\n+/, '');
  rest = rest.replace(/^\s+$/, '');
  if (!newLine) return rest;
  return rest ? `${newLine}\n\n${rest}` : newLine;
}
export const teacherText = (comment, storedLine) => composeComment(comment, storedLine, '').trim();
