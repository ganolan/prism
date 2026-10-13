// The test attempt page's form (linked quizzes phase 4b, spec §14). Serialized the way a browser
// submits it: checked against the phase 4a capture, byte for byte. Only the essay's level, points,
// override and comment are ever changed; every other field goes back exactly as Schoology sent it.
import { parse } from 'node-html-parser';
import { rubricButtons } from './parseQuizAttempt.js';

const FORM = '#s-assessment-edit-submission-form';
const TOKENS = new Set(['form_build_id', 'form_token']);
const num = (v) => (v == null || String(v).trim() === '' ? null : Number(v));

export const serializeAttemptForm = (html) => serializeForm(html, FORM);

// Any Schoology form by its selector (the attempt page, or the grade-by-question page's
// #s-assessment-view-question-responses-form), serialized as a browser submits it.
export function serializeForm(html, selector) {
  const form = parse(String(html ?? '')).querySelector(selector);
  if (!form) return null;
  const pairs = [];
  for (const el of form.querySelectorAll('input, textarea, select')) {
    const n = el.getAttribute('name');
    if (!n || el.hasAttribute('disabled')) continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && (type === 'checkbox' || type === 'radio') && !el.hasAttribute('checked')) continue;
    if (tag === 'input' && ['submit', 'button', 'image', 'reset'].includes(type)) {
      if (n === 'op' && el.getAttribute('value') === 'Save Changes') pairs.push([n, 'Save Changes']);
      continue;
    }
    if (tag === 'textarea') { pairs.push([n, el.text.replace(/^\n/, '').replace(/\r?\n/g, '\r\n')]); continue; }
    if (tag === 'select') {
      const o = el.querySelector('option[selected]') || el.querySelector('option');
      pairs.push([n, o ? (o.getAttribute('value') ?? o.text) : '']);
      continue;
    }
    pairs.push([n, el.getAttribute('value') ?? '']);
  }
  return { action: form.getAttribute('action'), pairs };
}

export const BYQ_FORM = '#s-assessment-view-question-responses-form';
export const submissionPrefix = (uid, attemptId) => `students[${uid}][submissions][${attemptId}]`;
const at = (prefix, field) => `${prefix}[${field}]`;
const essayPrefix = (qid) => `components[0][${qid}]`;

export const namesAt = (prefix) => ['points', 'override', 'rubric_score', 'comment'].map(f => at(prefix, f));
export function fieldsAt(pairs, prefix) {
  const m = new Map(pairs);
  if (!m.has(at(prefix, 'points'))) return null;
  return {
    rubricScore: num(m.get(at(prefix, 'rubric_score'))), points: num(m.get(at(prefix, 'points'))),
    override: num(m.get(at(prefix, 'override'))), comment: m.get(at(prefix, 'comment')) ?? '',
    maxPoints: num(m.get(at(prefix, 'max_points'))),
  };
}
export function withMarkAt(pairs, prefix, { points, comment }) {
  const set = {
    [at(prefix, 'points')]: String(points), [at(prefix, 'override')]: '1', [at(prefix, 'rubric_score')]: String(points),
    [at(prefix, 'comment')]: String(comment ?? '').replace(/\r?\n/g, '\r\n'),
  };
  return pairs.map(([k, v]) => [k, k in set ? set[k] : v]);
}
export const essayNames = (qid) => namesAt(essayPrefix(qid));
export const essayFields = (pairs, qid) => fieldsAt(pairs, essayPrefix(qid));
export const withEssayMark = (pairs, qid, mark) => withMarkAt(pairs, essayPrefix(qid), mark);

// One rubric launch entry per student on the by-question page: args are rubric id, enrollment id,
// question id, grade html, two numbers, attempt id, max points, two booleans (stage D page).
export function byQuestionRubrics(html) {
  const out = {};
  const re = /"template":"s_grades_rubric_grading_launch_btn"[^{}]*?"args":\[\s*"?(\d+)"?\s*,\s*"?(\d+)"?\s*,\s*"?(\d+)"?\s*,[^\]]*?,\s*"?\d+"?\s*,\s*"?\d+"?\s*,\s*"?(\d+)"?\s*,/g;
  for (const m of String(html).matchAll(re)) out[m[4]] = { rubricId: m[1], enrollmentId: m[2], qid: m[3] };
  return out;
}

export function changedNames(a, b) {
  const bm = new Map(b);
  const out = [];
  for (const [k, v] of a) if (!TOKENS.has(k) && bm.get(k) !== v) out.push(k);
  for (const [k] of b) if (!TOKENS.has(k) && !a.some(([ak]) => ak === k)) out.push(k);
  return out;
}

export const toBody = (pairs) => new URLSearchParams(pairs).toString();

// The ids the rubric grade read needs. The launch span is drawn by Schoology's script, so the raw page
// holds them only in its template JSON, read as the loader does (phase 4b round trip, 2026-10-13).
export function rubricLaunch(html, qid) {
  return rubricButtons(html)[String(qid)] ?? null;
}
