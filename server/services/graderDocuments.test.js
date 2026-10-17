import { describe, test, expect, beforeEach } from 'vitest';
import { fetchAssignmentSubmissionState } from './graderDocuments.js';
import { createSubmissionFetcher } from './graderSubmissions.js';
import { fakeSchoologyWeb } from '../testing/fakeSchoologyWeb.js';
import { sessionStatus, resetSessionStatusCache } from './schoologySession.js';

const SUB = '/iapi2/assignments/8555933030/submitted-documents/';
const INP = '/iapi2/assignments/8555933030/in-progress-documents/';
const submitted = { data: [{ id: 701, revisionCreated: true, submissionTiming: 2, submissionDate: 'Tuesday, June 9, 2026 at 3:27 pm' }] };
const inProgress = { data: [{ id: 702, revisionCreated: true, submissionTiming: 0, submissionDate: '' }, { id: 703, revisionCreated: false, submissionTiming: 0, submissionDate: '' }] };
const webFor = (routes) => {
  const fake = fakeSchoologyWeb({ routes });
  return { fake, web: { jar: fake.jar, fetchImpl: fake.fetchImpl } };
};

describe('fetchAssignmentSubmissionState (plain HTTP, #141)', () => {
  test('reads both document lists with the session cookie and Accept JSON → states + details', async () => {
    const { fake, web } = webFor({ [SUB]: { json: submitted }, [INP]: { json: inProgress } });
    const r = await fetchAssignmentSubmissionState(web, '8555933030');
    expect([...r.states]).toEqual([['702', 'in_progress'], ['703', 'not_started'], ['701', 'submitted']]);
    expect(r.details.get('701')).toMatchObject({ late: 1 });
    expect(fake.requests.map((q) => q.path).sort()).toEqual([INP, SUB]);
    for (const q of fake.requests) expect(q.headers).toMatchObject({ cookie: 'SESS=old', Accept: 'application/json' });
  });

  test('a list that is not a 200 JSON answer counts as missing; both missing → null', async () => {
    const one = webFor({ [SUB]: { status: 403, json: { data: null } }, [INP]: { json: inProgress } });
    expect([...(await fetchAssignmentSubmissionState(one.web, '8555933030')).states.keys()]).toEqual(['702', '703']);
    const none = webFor({ [SUB]: { status: 403, json: { data: null } }, [INP]: { text: '<html>' } });
    expect(await fetchAssignmentSubmissionState(none.web, '8555933030')).toBeNull();
  });

  test('null on a failed request or a sign-in bounce (onSessionExpired only for the bounce); never throws', async () => {
    let expired = 0;
    const down = webFor({ [SUB]: { throws: new Error('ECONNRESET') }, [INP]: { json: inProgress } });
    expect(await fetchAssignmentSubmissionState({ ...down.web, onSessionExpired: () => expired++ }, '8555933030')).toBeNull();
    expect(expired).toBe(0);
    const bounced = webFor({ [SUB]: { login: true }, [INP]: { login: true } });
    expect(await fetchAssignmentSubmissionState({ ...bounced.web, onSessionExpired: () => expired++ }, '8555933030')).toBeNull();
    expect(expired).toBeGreaterThan(0);
  });
});

describe('createSubmissionFetcher', () => {
  beforeEach(() => resetSessionStatusCache());

  test('null when there is no saved session (no jar)', async () => {
    expect(await createSubmissionFetcher({ jar: null })).toBeNull();
  });

  test('shares one jar: documents and test attempts over HTTP, no browser', async () => {
    const TESTS = '/iapi/grades/grader_grade_data/S1/all';
    const fake = fakeSchoologyWeb({ routes: {
      [SUB]: { json: submitted }, [INP]: { json: inProgress },
      [TESTS]: { json: { body: { grades: { 701: { T1: { uid: '701', grade_item_nid: 'T1', submission: 'assessment' } } } } } },
    } });
    const f = await createSubmissionFetcher({ jar: fake.jar, fetchImpl: fake.fetchImpl });
    expect((await f.fetchDocuments('8555933030')).states.get('701')).toBe('submitted');
    expect((await f.fetchTestAttempts('S1', ['701'], ['T1'])).get('701').get('T1')).toEqual({ took: true, notAssigned: false });
    await f.close();
  });

  test('after a sign-in bounce, later reads return null without a request and the session reads expired', async () => {
    const fake = fakeSchoologyWeb({ routes: { [SUB]: { login: true }, [INP]: { login: true } } });
    const f = await createSubmissionFetcher({ jar: fake.jar, fetchImpl: fake.fetchImpl });
    expect(await f.fetchDocuments('8555933030')).toBeNull();
    const sent = fake.requests.length;
    expect(await f.fetchDocuments('8555933030')).toBeNull();
    expect(await f.fetchTestAttempts('S1', ['701'], ['T1'])).toBeNull();
    expect(fake.requests.length).toBe(sent);
    expect((await sessionStatus({ check: false, hasSession: () => true })).live).toBe('expired');
  });
});
