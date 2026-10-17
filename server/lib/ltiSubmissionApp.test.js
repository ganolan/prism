import { describe, test, expect } from 'vitest';
import {
  parseLtiSubmissionApp, studentOpenUrl, driveLinksForSubmitted,
  GOOGLE_DRIVE, ONEDRIVE, OTHER_APP,
} from './ltiSubmissionApp.js';

// The assignment page's React props, JSON-escaped the way Schoology renders them
// (shape from the 2026-10-18 probe, ids replaced).
const page = (appId, host) => `<script>jQuery.extend(Drupal.settings, {"assignment":{"ltiSubmissionApp":{"id":${appId},` +
  `"launchUrl":"\\/apps\\/lti\\/${appId}\\/run\\/assignment\\/555?context=assignment_submission",` +
  `"submissionsTargetUrl":"https:\\/\\/${host}\\/lti\\/assignment-template\\/9074474","cookiePreloadUrl":null,"type":"lti","hasEditMode":true}}});</script>`;

describe('parseLtiSubmissionApp', () => {
  test('Google Drive: app id, launch URL and provider from the page props', () => {
    expect(parseLtiSubmissionApp(page('1073361950', 'lti-submission-google.app.schoology.com'))).toEqual({
      appId: '1073361950',
      launchUrl: '/apps/lti/1073361950/run/assignment/555?context=assignment_submission',
      targetHost: 'lti-submission-google.app.schoology.com',
      provider: GOOGLE_DRIVE,
    });
  });

  test('OneDrive is told apart by its own host', () => {
    expect(parseLtiSubmissionApp(page('1078786112', 'lti-submission-microsoft.app.schoology.com')).provider).toBe(ONEDRIVE);
  });

  test('an unknown submission app is reported as other, not assumed', () => {
    expect(parseLtiSubmissionApp(page('42', 'lti-submission-box.app.schoology.com')).provider).toBe(OTHER_APP);
  });

  test('a page with no LTI submission app gives null', () => {
    expect(parseLtiSubmissionApp('<html>Essay</html>')).toBeNull();
    expect(parseLtiSubmissionApp('')).toBeNull();
    expect(parseLtiSubmissionApp(null)).toBeNull();
  });

  test('the word "google" elsewhere on the page does not count', () => {
    const html = page('1078786112', 'lti-submission-microsoft.app.schoology.com') +
      '<a href="https://teachablemachine.withgoogle.com">Teachable Machine</a> core.microsoft_description';
    expect(parseLtiSubmissionApp(html).provider).toBe(ONEDRIVE);
  });
});

describe('studentOpenUrl', () => {
  const launch = '/apps/lti/1073361950/run/assignment/555?context=assignment_submission';

  test("the grader's open-in-new-tab URL on the school's web host", () => {
    expect(studentOpenUrl('https://schoology.hkis.edu.hk/', launch, '117438236')).toBe(
      'https://schoology.hkis.edu.hk/apps/lti/1073361950/run/assignment/555?context=assignment_submission' +
      '&custom_parameters[in_edit_mode]=true&studentId=117438236',
    );
  });

  test('a launch URL with no query gets ?', () => {
    expect(studentOpenUrl('https://s.example', '/apps/lti/1/run/assignment/2', '7'))
      .toBe('https://s.example/apps/lti/1/run/assignment/2?custom_parameters[in_edit_mode]=true&studentId=7');
  });

  test('never without a student: a blank studentId opens the teacher\'s template', () => {
    expect(studentOpenUrl('https://s.example', launch, '')).toBeNull();
    expect(studentOpenUrl('https://s.example', launch, null)).toBeNull();
    expect(studentOpenUrl('https://s.example', launch, 'abc')).toBeNull();
    expect(studentOpenUrl('https://s.example', null, '7')).toBeNull();
  });
});

describe('driveLinksForSubmitted', () => {
  const launch = '/apps/lti/1073361950/run/assignment/555?context=assignment_submission';
  const roster = [{ schoology_uid: '101' }, { schoology_uid: '102' }, { schoology_uid: '103' }];

  test('links only roster students who submitted, keyed by uid', () => {
    const submitted = [
      { id: 101, submissionStatus: 1, submissionDate: 'Thursday, March 16, 2023 at 1:52 pm' },
      { id: 999, submissionStatus: 1, submissionDate: '' }, // not on the roster (dropped)
    ];
    const links = driveLinksForSubmitted(submitted, roster, 'https://s.example', launch);
    expect(Object.keys(links)).toEqual(['101']);
    expect(links['101']).toEqual({
      url: `https://s.example${launch}&custom_parameters[in_edit_mode]=true&studentId=101`,
      provider: GOOGLE_DRIVE,
      submittedAt: new Date(2023, 2, 16, 13, 52).toISOString(),
    });
  });

  test('an unparseable submission date leaves submittedAt null', () => {
    const links = driveLinksForSubmitted([{ id: '102', submissionDate: '' }], roster, 'https://s.example', launch);
    expect(links['102'].submittedAt).toBeNull();
  });

  test('entries with no id link nobody; empty input gives no links', () => {
    expect(driveLinksForSubmitted([{ id: null }, {}], roster, 'https://s.example', launch)).toEqual({});
    expect(driveLinksForSubmitted(null, roster, 'https://s.example', launch)).toEqual({});
  });
});
