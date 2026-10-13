// Pure parser for one attempt page,
// GET /assignment/{id}/assessment_results/student_stats/{uid}/{attemptId}
// (browser session, read-only). Shape verified 2026-10-12:
// .claude/schoology-api-reference.md, "Questions, attempts and FRQ rubrics".
// Each question is a div.question-review.question-{type} holding its
// components[0][{qid}][...] inputs. The FRQ rubric button is rendered by
// JavaScript, so its ids come from the Drupal.settings blob, not from the HTML.
import { parse } from 'node-html-parser';
import { optionLetter } from './quizText.js';

const KIND = { multiple_choice: 'mcq', essay: 'frq' };
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

const LAUNCH = '"template":"s_grades_rubric_grading_launch_btn"';

// The index of the quote that closes the JSON string opening at `i`, or -1.
function stringEnd(s, i) {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '"') return j;
  }
  return -1;
}

// The index of the bracket that closes the array or object opening at `start`, or -1.
function closing(s, start) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') { i = stringEnd(s, i); if (i === -1) return -1; }
    else if (ch === '[' || ch === '{') depth++;
    else if ((ch === ']' || ch === '}') && --depth === 0) return i;
  }
  return -1;
}

// The "args" array of the object a launch entry's template key sits in: scanned forward, string-aware, at
// the object's own depth, then JSON-parsed. Null when the object closes first or the array does not parse.
function argsAfter(s, from) {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      const end = stringEnd(s, i);
      if (end === -1) return null;
      if (depth === 0 && s.slice(i, end + 1) === '"args"') {
        const colon = /^\s*:\s*\[/.exec(s.slice(end + 1, end + 64));
        if (!colon) return null;
        const start = end + colon[0].length;
        const close = closing(s, start);
        if (close === -1) return null;
        try {
          const v = JSON.parse(s.slice(start, close + 1));
          return Array.isArray(v) ? v : null;
        } catch { return null; }
      }
      i = end;
    } else if (ch === '{' || ch === '[') depth++;
    else if ((ch === '}' || ch === ']') && --depth < 0) return null;
  }
  return null;
}

// The args of each rubric launch entry in Schoology's template JSON, one entry at a time, so one malformed
// entry or a bad outer slice cannot drop every rubric button, and an entry without args cannot take the
// args of the entry after it. Each entry's args are JSON-parsed, so brackets in the grade html are safe.
// Args (attempt page and by-question page): rubric id, enrollment id, question id, grade html, two
// numbers, attempt id, max points, two booleans.
export function rubricLaunchArgs(html) {
  const s = String(html ?? '');
  const out = [];
  for (let i = s.indexOf(LAUNCH); i !== -1; i = s.indexOf(LAUNCH, i + LAUNCH.length)) {
    const args = argsAfter(s, i + LAUNCH.length);
    if (args) out.push(args);
  }
  return out;
}

// An id in the args: digits, as a string or a number. Anything else is null.
export const launchId = (v) => ((typeof v === 'string' || typeof v === 'number') && /^\d+$/.test(String(v)) ? String(v) : null);

// Rubric id and enrollment id per question id.
export function rubricButtons(html) {
  const out = {};
  for (const args of rubricLaunchArgs(html)) {
    const [rubricId, enrollmentId, qid] = args.slice(0, 3).map(launchId);
    if (rubricId && enrollmentId && qid) out[qid] = { rubricId, enrollmentId };
  }
  return out;
}

export function parseQuizAttempt(html) {
  const root = parse(String(html ?? ''));
  if (!root.querySelector('#s-assessment-edit-submission-form')) return null;
  const buttons = rubricButtons(html);
  const questions = [];
  for (const block of root.querySelectorAll('div.question-review')) {
    const cls = (block.getAttribute('class') || '').split(/\s+/).find(c => c.startsWith('question-') && c !== 'question-review');
    const field = (name) => block.querySelectorAll('input, textarea')
      .find(el => new RegExp(`^components\\[0\\]\\[\\d+\\]\\[${name}\\]$`).test(el.getAttribute('name') || ''));
    const pointsInput = field('points');
    if (!pointsInput) continue;
    const qid = pointsInput.getAttribute('name').match(/^components\[0\]\[(\d+)\]/)[1];
    const kind = KIND[cls?.slice('question-'.length)] || 'other';
    const ul = block.querySelector('ul.multiple-choice-review');
    const options = ul ? ul.querySelectorAll('li').map((li, i) => {
      const classes = (li.getAttribute('class') || '').split(/\s+/);
      return {
        letter: optionLetter(i),
        html: li.querySelector('.option-span')?.innerHTML.trim() ?? '',
        selected: classes.includes('selected'),
        isKey: classes.includes('correct'),
      };
    }) : null;
    const chosen = options?.find(o => o.selected) || null;
    questions.push({
      qid,
      kind,
      points: num(pointsInput.getAttribute('value')),
      maxPoints: num(field('max_points')?.getAttribute('value')),
      rubricScore: num(field('rubric_score')?.getAttribute('value')),
      comment: field('comment')?.text ?? '',
      options,
      chosenLetter: chosen ? chosen.letter : null,
      isCorrect: options ? !!(chosen && chosen.isKey) : null,
      answerHtml: block.querySelector('.essay-review')?.innerHTML.trim() ?? null,
      rubric: buttons[qid] || null,
    });
  }
  return { questions };
}
