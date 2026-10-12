// Text helpers for linked quizzes.
//
// normalizeStem is the comparison key Prism uses to match copies of the same
// Schoology question (copies get new question ids). It keeps Unicode letters and
// digits plus the comparison and arithmetic operators, lowercased, and drops
// everything else (whitespace, punctuation, arrows). The HTML and plain renderings
// of one stem therefore give the same key, while `x < 5` and `x > 5` never match.
import { parse } from 'node-html-parser';

// Script, style and noscript text is not question content: remove it before parsing.
const DROPPED_BLOCKS = /<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
// Breaks and block closers become a space, so adjacent blocks do not run together.
const BLOCK_BREAKS = /<br\s*\/?>|<\/(p|div|li|pre|h[1-6]|tr|td)\s*>/gi;

export function plainText(html) {
  const cleaned = String(html ?? '').replace(DROPPED_BLOCKS, ' ').replace(BLOCK_BREAKS, ' ');
  // No block-text elements: <pre> content is parsed as HTML, so its entities and
  // inline tags come out as text rather than raw markup.
  return parse(cleaned, { blockTextElements: {} }).text.replace(/\s+/g, ' ').trim();
}

export function normalizeStem(html) {
  return plainText(html).toLowerCase().replace(/[^\p{L}\p{N}<>=+\-*/%!≠≤≥]+/gu, '');
}

export const optionLetter = (index) => String.fromCharCode(65 + index);

// Schoology's results pages print "10/09/26 8:51am" (US month first, 2-digit year,
// no time zone: the school's display zone). → 'YYYY-MM-DD HH:MM' local, or null.
export function parseUsDateTime(text) {
  const m = String(text ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (!m) return null;
  const [, mo, d, yy, h, min, ap] = m;
  const month = Number(mo);
  const day = Number(d);
  const hour12 = Number(h);
  const minute = Number(min);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  let hour = hour12 % 12;
  if (ap.toLowerCase() === 'pm') hour += 12;
  const pad = (n) => String(n).padStart(2, '0');
  return `20${yy}-${pad(mo)}-${pad(d)} ${pad(hour)}:${min}`;
}

export function questionFingerprint({ kind, stemHtml, points }) {
  return `${kind}|${normalizeStem(stemHtml)}|${Number(points)}`;
}
