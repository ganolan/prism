import { describe, test, expect } from 'vitest';
import { fetchSectionTestAttempts } from './graderTestAttempts.js';
import { fakeSchoologyWeb } from '../testing/fakeSchoologyWeb.js';

const PATH = '/iapi/grades/grader_grade_data/8458134140/all';
const PAYLOAD = { body: { grades: { 701: { T1: { uid: '701', grade_item_nid: 'T1', submission: 'assessment', has_assessment: true } } } } };
const webFor = (spec) => {
  const fake = fakeSchoologyWeb({ routes: { [PATH]: spec } });
  let expired = 0;
  const web = { jar: fake.jar, fetchImpl: fake.fetchImpl, onSessionExpired: () => { expired++; } };
  return { fake, web, expired: () => expired };
};

describe('fetchSectionTestAttempts (plain HTTP, #141)', () => {
  test('one grader_grade_data GET for the section (period "all") with the session cookie and Accept JSON; parsed result', async () => {
    const { fake, web } = webFor({ json: PAYLOAD });
    const m = await fetchSectionTestAttempts(web, '8458134140', ['701', '702'], ['T1', 'T2']);
    expect(m.get('701').get('T1')).toEqual({ took: true, notAssigned: false });
    expect(fake.requests).toHaveLength(1);
    const [r] = fake.requests;
    expect(r.path).toBe(PATH);
    expect(r.query.get('uids')).toBe('701,702');
    expect(r.query.get('grade_item_nids')).toBe('T1,T2');
    expect(r.headers).toMatchObject({ cookie: 'SESS=old', Accept: 'application/json' });
  });

  test('null and onSessionExpired when Schoology sends the read to sign-in', async () => {
    const { web, expired } = webFor({ login: true });
    expect(await fetchSectionTestAttempts(web, '8458134140', ['701'], ['T1'])).toBeNull();
    expect(expired()).toBe(1);
  });

  test('null on a failed/timed-out fetch, a non-200 or a bad payload; never throws', async () => {
    const err = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    for (const spec of [{ throws: err }, { status: 500, json: PAYLOAD }, { json: null }, { json: { body: [] } }, { text: '<html>' }]) {
      const { web, expired } = webFor(spec);
      expect(await fetchSectionTestAttempts(web, '8458134140', ['701'], ['T1'])).toBeNull();
      expect(expired()).toBe(0);
    }
  });

  test('null without students or tests (nothing to ask)', async () => {
    const { fake, web } = webFor({ json: PAYLOAD });
    expect(await fetchSectionTestAttempts(web, '8458134140', [], ['T1'])).toBeNull();
    expect(await fetchSectionTestAttempts(web, '8458134140', ['701'], [])).toBeNull();
    expect(fake.requests).toHaveLength(0);
  });
});
