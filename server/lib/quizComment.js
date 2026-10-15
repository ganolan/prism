// The overall comment on a quiz's result task (spec §7, §13). Prism builds it from the group's
// template so the numbers always match the stored data; the agent writes only {impression}.
// Pure: no database, no Schoology.
export const PLACEHOLDERS = ['mcq_correct', 'mcq_total', 'mcq_percent', 'frq_levels', 'impression'];

const MCQ_LINE = 'Multiple choice: {mcq_correct}/{mcq_total} ({mcq_percent}%)';
const FRQ_LINE = 'Free response: {frq_levels}';
const ATTEMPT_LINE = 'Open your attempt on the test to read the feedback on each free-response question.';
const TOKEN = /\{([^{}]*)\}/g;

export function defaultTemplate({ hasMcq, hasFrq }) {
  return [
    ...(hasMcq ? [MCQ_LINE] : []),
    ...(hasFrq ? [FRQ_LINE] : []),
    '{impression}',
    ...(hasFrq ? [ATTEMPT_LINE] : []),
  ].join('\n');
}

export function validateTemplate(template) {
  const used = [...String(template ?? '').matchAll(TOKEN)].map(m => m[1]);
  const unknown = [...new Set(used.filter(p => !PLACEHOLDERS.includes(p)))];
  if (unknown.length) {
    return { error: `Unknown placeholder${unknown.length > 1 ? 's' : ''}: ${unknown.map(p => `{${p}}`).join(', ')}` };
  }
  if (!used.includes('impression')) return { error: 'The template needs {impression}' };
  return { ok: true };
}

const isEmpty = (v) => v == null || String(v).trim() === '';

export function buildComment(template, values) {
  const lines = String(template ?? '').replace(/\r\n?/g, '\n').split('\n').flatMap((line) => {
    const names = [...line.matchAll(TOKEN)].map(m => m[1]);
    if (names.length && names.every(k => isEmpty(values[k]))) return [];
    return [line.replace(TOKEN, (_, k) => (isEmpty(values[k]) ? '' : String(values[k]))).replace(/\s+$/, '')];
  });
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

export function frqLevelsText(frqs) {
  return (frqs || []).map((f) => {
    if (!f.has_rubric) return `Q${f.question} ${f.points}/${f.max_points} points`;
    if (f.levels.length === 1) return `Q${f.question} ${f.levels[0].level}`;
    return `Q${f.question} (${f.levels.map(l => `${l.row}: ${l.level}`).join(', ')})`;
  }).join(', ');
}
