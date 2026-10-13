// The test attempt page's form (linked quizzes phase 4b, spec §14). Serialized the way a browser
// submits it: checked against the phase 4a capture, byte for byte. Only the essay's level, points,
// override and comment are ever changed; every other field goes back exactly as Schoology sent it.
import { parse } from 'node-html-parser';

const FORM = '#s-assessment-edit-submission-form';
const TOKENS = new Set(['form_build_id', 'form_token']);
const name = (qid, field) => `components[0][${qid}][${field}]`;
const num = (v) => (v == null || String(v).trim() === '' ? null : Number(v));

export function serializeAttemptForm(html) {
  const form = parse(String(html ?? '')).querySelector(FORM);
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

export const essayNames = (qid) => ['points', 'override', 'rubric_score', 'comment'].map(f => name(qid, f));

export function essayFields(pairs, qid) {
  const m = new Map(pairs);
  if (!m.has(name(qid, 'points'))) return null;
  return {
    rubricScore: num(m.get(name(qid, 'rubric_score'))),
    points: num(m.get(name(qid, 'points'))),
    override: num(m.get(name(qid, 'override'))),
    comment: m.get(name(qid, 'comment')) ?? '',
    maxPoints: num(m.get(name(qid, 'max_points'))),
  };
}

export function withEssayMark(pairs, qid, { points, comment }) {
  const set = {
    [name(qid, 'points')]: String(points),
    [name(qid, 'override')]: '1',
    [name(qid, 'rubric_score')]: String(points),
    [name(qid, 'comment')]: String(comment ?? '').replace(/\r?\n/g, '\r\n'),
  };
  return pairs.map(([k, v]) => [k, k in set ? set[k] : v]);
}

export function changedNames(a, b) {
  const bm = new Map(b);
  const out = [];
  for (const [k, v] of a) if (!TOKENS.has(k) && bm.get(k) !== v) out.push(k);
  for (const [k] of b) if (!TOKENS.has(k) && !a.some(([ak]) => ak === k)) out.push(k);
  return out;
}

export const toBody = (pairs) => new URLSearchParams(pairs).toString();
