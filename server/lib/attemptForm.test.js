import { describe, test, expect } from 'vitest';
import { serializeAttemptForm, essayFields, withEssayMark, changedNames, essayNames, toBody, rubricLaunch } from './attemptForm.js';

// A synthetic attempt form in the observed shape (schoology-api-reference.md, "Saving an FRQ level and comment").
const q = (qid, { points, override = 0, original = points, max = 1, score = '', comment = '' }) => `
  <div class="question-review question-x">
    <input type="hidden" name="components[0][${qid}][points]" value="${points}">
    <input type="hidden" name="components[0][${qid}][override]" value="${override}">
    <input type="hidden" name="components[0][${qid}][original_points]" value="${original}">
    <input type="hidden" name="components[0][${qid}][max_points]" value="${max}">
    <input type="hidden" name="components[0][${qid}][rubric_score]" value="${score}">
    <textarea name="components[0][${qid}][comment]">${comment}</textarea>
  </div>`;
const PAGE = (essay = { points: 2, override: 1, original: 0, max: 4, score: '2', comment: 'Good &amp; clear' }) => `<html><body>
  <form id="s-assessment-edit-submission-form" action="/assignment/900/assessment_results/student_stats/701/5001" accept-charset="UTF-8" method="post">
    <select name="enrollment-selector-sa"><option value="/a">A</option><option value="/assignment/900/assessment_results/student_stats/701/5001" selected="selected">B</option></select>
    ${q('11', { points: 1 })}${q('12', { points: 0 })}${q('21', essay)}
    <input type="submit" name="op" value="Save Changes">
    <input type="submit" name="op" value="Cancel">
    <input type="hidden" name="form_build_id" value="form-abc">
    <input type="hidden" name="form_token" value="tok">
    <input type="hidden" name="form_id" value="s_assessment_edit_submission_form">
  </form></body></html>`;

describe('serializeAttemptForm', () => {
  test('every named field in page order, the chosen option, only the Save Changes button', () => {
    const f = serializeAttemptForm(PAGE());
    expect(f.action).toBe('/assignment/900/assessment_results/student_stats/701/5001');
    expect(f.pairs.map(p => p[0])).toEqual([
      'enrollment-selector-sa',
      ...['11', '12', '21'].flatMap(id => ['points', 'override', 'original_points', 'max_points', 'rubric_score', 'comment'].map(k => `components[0][${id}][${k}]`)),
      'op', 'form_build_id', 'form_token', 'form_id',
    ]);
    expect(f.pairs[0][1]).toBe('/assignment/900/assessment_results/student_stats/701/5001');
    expect(Object.fromEntries(f.pairs).op).toBe('Save Changes');
    expect(Object.fromEntries(f.pairs)['components[0][21][comment]']).toBe('Good & clear');
  });
  test('no form is null', () => {
    expect(serializeAttemptForm('<html><body>Sign in</body></html>')).toBeNull();
  });
});

describe('the essay', () => {
  const pairs = serializeAttemptForm(PAGE()).pairs;
  test('reads its fields', () => {
    expect(essayFields(pairs, '21')).toEqual({ rubricScore: 2, points: 2, override: 1, comment: 'Good & clear', maxPoints: 4 });
    expect(essayFields(pairs, '99')).toBeNull();
  });
  test('an empty rubric score is null', () => {
    const p = serializeAttemptForm(PAGE({ points: 0, override: 0, original: 0, max: 4, score: '', comment: '' })).pairs;
    expect(essayFields(p, '21')).toMatchObject({ rubricScore: null, override: 0, comment: '' });
  });
  test('withEssayMark changes only the essay level, points, override and comment', () => {
    const next = withEssayMark(pairs, '21', { points: 3, comment: 'Line one\nLine two <b> & é' });
    expect(changedNames(pairs, next)).toEqual(['components[0][21][points]', 'components[0][21][rubric_score]', 'components[0][21][comment]']);
    expect(essayFields(next, '21')).toEqual({ rubricScore: 3, points: 3, override: 1, comment: 'Line one\r\nLine two <b> & é', maxPoints: 4 });
    expect(changedNames(pairs, next).every(n => essayNames('21').includes(n))).toBe(true);
  });
  test('override becomes 1 when it was 0', () => {
    const p = serializeAttemptForm(PAGE({ points: 0, override: 0, original: 0, max: 4, score: '', comment: '' })).pairs;
    expect(essayFields(withEssayMark(p, '21', { points: 4, comment: 'x' }), '21').override).toBe(1);
  });
  test('changedNames ignores the Drupal tokens', () => {
    const other = pairs.map(([k, v]) => [k, k === 'form_build_id' ? 'form-new' : k === 'form_token' ? 'tok2' : v]);
    expect(changedNames(pairs, other)).toEqual([]);
  });
});

describe('toBody', () => {
  test('url-encoded as a browser sends it: spaces as +, UTF-8, CRLF kept', () => {
    expect(toBody([['a', 'x y'], ['c', 'é\r\n&']])).toBe('a=x+y&c=%C3%A9%0D%0A%26');
  });
});

describe('rubricLaunch', () => {
  test('the rubric and enrollment ids from the question\'s launch span', () => {
    const html = '<div><span class="grading-rubric-launch-icon grading-rubric-grading-launch" rubric-id="36010096" enrollment-id="3174490355" item-id="2128035490" editable="true"></span></div>';
    expect(rubricLaunch(html, '2128035490')).toEqual({ rubricId: '36010096', enrollmentId: '3174490355' });
    expect(rubricLaunch(html, '1')).toBeNull();
  });
});
