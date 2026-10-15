// Pure parser for a Schoology test's question list,
// GET /assignment/{id}/assessment_questions (browser session, read-only).
// Shape verified 2026-10-12: .claude/schoology-api-reference.md, "Questions,
// attempts and FRQ rubrics". The page has no answer options and no key; those
// come from attempt pages (parseQuizAttempt).
import { parse } from 'node-html-parser';

const KIND = { multiple_choice: 'mcq', essay: 'frq' };

export function parseQuizQuestions(html) {
  const root = parse(String(html ?? ''));
  const out = [];
  for (const input of root.querySelectorAll('input')) {
    const m = (input.getAttribute('name') || '').match(/^components\[(\d+)\]\[delta\]$/);
    if (!m) continue;
    const row = input.closest('tr');
    const wrapper = row?.querySelector('.component-summary-wrapper');
    if (!wrapper) continue;
    const typeClass = (wrapper.getAttribute('class') || '').split(/\s+/).find(c => c.startsWith('component-') && c !== 'component-summary-wrapper');
    const type = typeClass ? typeClass.slice('component-'.length) : '';
    const points = Number((row.querySelector('.component-points')?.text || '').match(/[\d.]+/)?.[0] ?? NaN);
    out.push({
      qid: m[1],
      number: Number(row.querySelector('.component-number')?.text.trim()),
      delta: Number(input.getAttribute('value')),
      kind: KIND[type] || 'other',
      stemHtml: row.querySelector('.component-title')?.innerHTML.trim() ?? '',
      points: Number.isFinite(points) ? points : null,
    });
  }
  if (!out.length) return null;
  return out.sort((a, b) => a.delta - b.delta);
}
