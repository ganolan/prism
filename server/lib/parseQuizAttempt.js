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

// The settings blob is not always valid JSON (the button args carry an unescaped
// inline <span class="...">), so the launch-button args are read with a regex:
// template name, then the first three args (rubric id, enrollment id, question id).
function rubricButtons(html) {
  const out = {};
  const re = /"template":"s_grades_rubric_grading_launch_btn"[\s\S]*?"args":\[\s*"(\d+)"\s*,\s*"(\d+)"\s*,\s*"(\d+)"/g;
  for (const m of String(html).matchAll(re)) {
    out[m[3]] = { rubricId: m[1], enrollmentId: m[2] };
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
