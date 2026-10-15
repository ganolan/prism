import { describe, test, expect } from 'vitest';
import { defaultTemplate, validateTemplate, buildComment, frqLevelsText, PLACEHOLDERS } from './quizComment.js';

const FULL = 'Multiple choice: {mcq_correct}/{mcq_total} ({mcq_percent}%)\nFree response: {frq_levels}\n{impression}\nOpen your attempt on the test to read the feedback on each free-response question.';

describe('defaultTemplate', () => {
  test('MCQ and FRQ: the spec §7 template', () => {
    expect(defaultTemplate({ hasMcq: true, hasFrq: true })).toBe(FULL);
  });
  test('MCQ only: no free-response lines', () => {
    expect(defaultTemplate({ hasMcq: true, hasFrq: false })).toBe('Multiple choice: {mcq_correct}/{mcq_total} ({mcq_percent}%)\n{impression}');
  });
  test('FRQ only: no multiple-choice line', () => {
    expect(defaultTemplate({ hasMcq: false, hasFrq: true }).split('\n')[0]).toBe('Free response: {frq_levels}');
  });
});

describe('validateTemplate', () => {
  test('accepts the known placeholders', () => {
    expect(validateTemplate(FULL)).toEqual({ ok: true });
    expect(PLACEHOLDERS).toEqual(['mcq_correct', 'mcq_total', 'mcq_percent', 'frq_levels', 'impression']);
  });
  test('names each unknown placeholder once', () => {
    expect(validateTemplate('{impression} {score} {score} {name}')).toEqual({ error: 'Unknown placeholders: {score}, {name}' });
  });
  test('requires {impression}', () => {
    expect(validateTemplate('Multiple choice: {mcq_percent}%')).toEqual({ error: 'The template needs {impression}' });
  });
});

describe('buildComment', () => {
  const values = { mcq_correct: 17, mcq_total: 20, mcq_percent: 85, frq_levels: 'Q21 Exhibiting', impression: 'A secure start.' };
  test('fills every placeholder', () => {
    expect(buildComment(FULL, values)).toBe('Multiple choice: 17/20 (85%)\nFree response: Q21 Exhibiting\nA secure start.\nOpen your attempt on the test to read the feedback on each free-response question.');
  });
  test('drops a line whose placeholders are all empty, keeps lines without placeholders', () => {
    const t = 'Multiple choice: {mcq_percent}%\nFree response: {frq_levels}\n{impression}\nWell done.';
    expect(buildComment(t, { mcq_percent: 90, frq_levels: null, impression: 'Good.' })).toBe('Multiple choice: 90%\nGood.\nWell done.');
  });
  test('trims blank lines at the start and the end, keeps blank lines inside', () => {
    expect(buildComment('\n\n{impression}\n\nThanks.\n\n', { impression: 'Hi.' })).toBe('Hi.\n\nThanks.');
  });
  test('a multi-line impression stays as written; 0 is a value, not empty', () => {
    expect(buildComment('MCQ {mcq_correct}\n{impression}', { mcq_correct: 0, impression: 'One.\nTwo.' })).toBe('MCQ 0\nOne.\nTwo.');
  });
});

describe('frqLevelsText', () => {
  test('one row, several rows, no rubric, in the order given', () => {
    expect(frqLevelsText([
      { question: 21, has_rubric: true, levels: [{ row: 'Content Knowledge', level: 'Exhibiting', points: 3 }] },
      { question: 22, has_rubric: true, levels: [{ row: 'Content', level: 'Exhibiting', points: 3 }, { row: 'Code', level: 'Developing', points: 2 }] },
      { question: 23, has_rubric: false, levels: [{ row: 'Points', level: null, points: 3 }], points: 3, max_points: 4 },
    ])).toBe('Q21 Exhibiting, Q22 (Content: Exhibiting, Code: Developing), Q23 3/4 points');
  });
  test('no FRQs is empty', () => {
    expect(frqLevelsText([])).toBe('');
  });
});
