import { describe, test, expect, beforeEach } from 'vitest';
import { getArchivedSections, fetchArchivedCoursesHtml, PAST_COURSES_PATH } from './archivedCourses.js';
import { PAST_COURSES_HTML } from '../lib/__fixtures__/pastCoursesSample.js';
import { fakeSchoologyWeb } from '../testing/fakeSchoologyWeb.js';
import { sessionStatus, resetSessionStatusCache } from './schoologySession.js';

describe('getArchivedSections', () => {
  test('parses sections from fetched html', async () => {
    const list = await getArchivedSections(async () => PAST_COURSES_HTML);
    expect(list).toHaveLength(4);
    expect(list.map((s) => s.sectionId)).toContain('7002');
  });

  test('returns null when html is unavailable (no/expired session)', async () => {
    const list = await getArchivedSections(async () => null);
    expect(list).toBeNull();
  });
});

describe('fetchArchivedCoursesHtml (plain HTTP, #141)', () => {
  beforeEach(() => resetSessionStatusCache());

  test('GETs the past-courses page with the session cookie → its HTML', async () => {
    const web = fakeSchoologyWeb({ routes: { [PAST_COURSES_PATH]: { text: PAST_COURSES_HTML } } });
    expect(await fetchArchivedCoursesHtml({ jar: web.jar, fetchImpl: web.fetchImpl })).toBe(PAST_COURSES_HTML);
    expect(web.requests).toHaveLength(1);
    expect(web.requests[0].headers.cookie).toBe('SESS=old');
  });

  test('null with no saved session (no request), on a sign-in bounce (session marked expired) or a non-200', async () => {
    expect(await fetchArchivedCoursesHtml({ jar: null })).toBeNull();
    const bounced = fakeSchoologyWeb({ routes: { [PAST_COURSES_PATH]: { login: true } } });
    expect(await fetchArchivedCoursesHtml({ jar: bounced.jar, fetchImpl: bounced.fetchImpl })).toBeNull();
    expect((await sessionStatus({ check: false, hasSession: () => true })).live).toBe('expired');
    const down = fakeSchoologyWeb({ routes: { [PAST_COURSES_PATH]: { status: 503, text: '' } } });
    expect(await fetchArchivedCoursesHtml({ jar: down.jar, fetchImpl: down.fetchImpl })).toBeNull();
  });
});
