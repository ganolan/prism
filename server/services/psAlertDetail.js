// One PowerSchool alert's detail for one student (#160), read on demand for the roster's alert
// pop-up and for Test day: the pop-up PowerSchool's own alert icon opens (readAlertPopup in
// psSupportSummary.js: the attendance LTI launch, the section roster, the pop-up GET). Nothing is
// stored; an answer is kept in memory for 10 minutes per student and alert. For the teacher only.
//
// Shapes probed 25/10/2026 (.claude/powerschool-api-reference.md "Alert pop-up shapes, all kept
// alerts"): a Category | Description table (Support Summary), a wider table (allergies), plain text
// lines (no photo, the accommodation plan's one sentence). Several alerts were not probed, so a pop-up
// is read by what it holds: a table gives rows, else its visible text gives text, else kind 'none'.
// A table is never assumed. Family alerts are never served here (NOT_ROSTER).
import { ALERT_DEFS, ROSTER_CATEGORIES } from '../lib/psAlerts.js';
import { decode } from '../lib/parseSupportSummary.js';
import { suggestExtraTime } from '../lib/extraTime.js';
import { PS_SCHOOL_ID } from './psAlertsSync.js';
import { readSupportSummary, readAlertPopup, popupLink, SupportSummaryError } from './psSupportSummary.js';

const TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // `${studentId}:${alertKey}` → { detail, at }
export const clearAlertDetailCache = () => cache.clear();

const DEF_BY_KEY = new Map(ALERT_DEFS.map((d) => [d.key, d]));
// Alerts with no pop-up to read: the plugin builds mobility's link without a stub_url (a manual alert).
const NO_POPUP = new Set(['mobility']);

const stripTags = (html) => decode(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const SUMMARY_HEADERS = [/^category$/i, /^(description|details)$/i];

// The page's first table. → { found, rows, loose }
//  - rows: { category, description, url?, group? }. The Support Summary layout (Category | Description,
//    or Details) and a header-less two-column table are read cell by cell, as parseSupportSummary reads
//    the Support Summary. Any other table pairs each cell with the header over it (blank cells left out),
//    `group` numbering the body row when there are several.
//  - loose: the text of a cell with no header over it: a body row of one cell, or short by more than the one
//    trailing column the recorded allergies table can lack (its "one cell" answer), is never labelled with a
//    header it may not belong to.
function readTable(html) {
  const table = html.match(/<table\b[\s\S]*?<\/table>/i)?.[0];
  if (!table) return { found: false, rows: [], loose: [] };
  const trs = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
  const cellsOf = (tr, tag) => [...tr.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))].map((m) => m[1]);
  const linkOf = (cell) => { const href = cell.match(/<a\b[^>]*href="([^"]+)"/i)?.[1]; return href ? { url: decode(href) } : {}; };
  let headers = trs.map((tr) => cellsOf(tr, 'th')).find((h) => h.length)?.map(stripTags);
  let body = trs.map((tr) => cellsOf(tr, 'td')).filter((c) => c.length);
  if (!headers && body.length && body[0].length !== 2) {
    // No <th>: the first row stands in as headers only when something sits under it; alone it is content.
    if (body.length === 1) return { found: true, rows: [], loose: body[0].map(stripTags).filter(Boolean) };
    headers = body[0].map(stripTags); body = body.slice(1);
  }
  const rows = [];
  const loose = [];
  const summaryLayout = headers ? headers.length === 2 && SUMMARY_HEADERS.every((re, i) => re.test(headers[i])) : true;
  if (summaryLayout) {
    for (const cells of body) {
      if (cells.length < 2) { const t = stripTags(cells[0]); if (t) loose.push(t); continue; }
      const row = { category: stripTags(cells[0]), description: stripTags(cells[1]), ...linkOf(cells[1]) };
      if (row.category) rows.push(row);
    }
    return { found: true, rows, loose };
  }
  body.forEach((cells, i) => {
    const group = body.length > 1 ? { group: i + 1 } : {};
    // The recorded allergies table has 10 headers over 9-cell rows for some students (the extra header is the
    // trailing legacy column), so a row may be one cell short and still line up; a lone cell never does.
    const aligned = cells.length > 1 && cells.length >= headers.length - 1;
    cells.forEach((cell, j) => {
      const description = stripTags(cell);
      if (!description) return;
      if (aligned && headers[j]) rows.push({ category: headers[j], description, ...linkOf(cell), ...group });
      else loose.push(description);
    });
  });
  return { found: true, rows, loose };
}

// The page's visible text, one line per paragraph or <br>, scripts and styles dropped.
function visibleText(html) {
  return decode(String(html)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?(p|div|h[1-6]|li|tr)\b[^>]*>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

// → { kind: 'rows', rows } | { kind: 'text', text } | { kind: 'none' }
// Rows when a table has cells under headers; a table of lone cells is text; a table with headers and no
// cells is none (its header names are not content); a page with no table is its visible text.
export function parseAlertPopup(html) {
  const page = String(html || '');
  const { found, rows, loose } = readTable(page);
  if (rows.length) return { kind: 'rows', rows: [...rows, ...loose.map((description) => ({ category: '', description }))] };
  const text = loose.length ? loose.join('\n') : visibleText(found ? page.replace(/<table\b[\s\S]*?<\/table>/i, ' ') : page);
  return text ? { kind: 'text', text } : { kind: 'none' };
}

const suggest = (def, detail) => {
  if (def.category !== 'learning') return null;
  const text = detail.kind === 'rows' ? detail.rows.map((r) => r.description).join('\n') : detail.kind === 'text' ? detail.text : '';
  return suggestExtraTime(text);
};

// → { alertKey, kind: 'rows' | 'text' | 'none', rows?, text?, suggestedPercent, readAt }
// Throws SupportSummaryError: NOT_ROSTER (a family or unknown key), then the support-summary read's codes.
export async function readAlertDetail(db, studentId, alertKey, deps = {}) {
  const { now = Date.now } = deps;
  const def = DEF_BY_KEY.get(alertKey);
  if (!def || !ROSTER_CATEGORIES.includes(def.category)) {
    throw new SupportSummaryError('NOT_ROSTER', 'This alert is not shown on a roster');
  }
  const key = `${studentId}:${alertKey}`;
  const hit = cache.get(key);
  if (hit && now() - hit.at <= TTL_MS) return hit.detail;

  const student = db.prepare('SELECT 1 FROM students WHERE id = ?').get(studentId);
  if (!student) throw new SupportSummaryError('NOT_FOUND', 'Student not found');
  const holds = (k) => db.prepare('SELECT 1 FROM student_ps_alerts WHERE student_id = ? AND alert_key = ?').get(studentId, k);
  if (!holds(alertKey)) throw new SupportSummaryError('NO_ALERT', `PowerSchool shows no ${def.label} for this student`);

  let body;
  if (def.category === 'learning' && holds('support_summary')) {
    const { rows, readAt } = await readSupportSummary(db, studentId, deps);
    body = { ...(rows.length ? { kind: 'rows', rows } : { kind: 'none' }), readAt };
  } else if (NO_POPUP.has(alertKey)) {
    body = { kind: 'none' };
  } else {
    const html = await readAlertPopup(db, studentId, alertKey, deps, async (ps, { dcid, studentid }) => {
      const catalogue = await ps.read('/teachers/mba_alerts/queries/getAlertTypes.json', { disabled: 0, student_schoolid: PS_SCHOOL_ID });
      const type = (Array.isArray(catalogue) ? catalogue : []).find((t) => t && String(t.id) === def.psAlertIds[0]);
      return type?.stub_url ? popupLink(type, dcid, studentid) : null;
    }, { name: def.label });
    body = html == null ? { kind: 'none' } : parseAlertPopup(html);
  }
  const detail = { alertKey, ...body, suggestedPercent: suggest(def, body), readAt: body.readAt ?? new Date(now()).toISOString() };
  cache.set(key, { detail, at: now() });
  return detail;
}
