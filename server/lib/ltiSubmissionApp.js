/**
 * ltiSubmissionApp.js
 *
 * Pure helpers for telling which Schoology app backs an lti_submission task and
 * for opening a student's copy (#142). The public API doesn't name the app; the
 * assignment page's props do:
 *   "launchUrl":"/apps/lti/{appId}/run/assignment/{aid}?context=assignment_submission"
 *   "submissionsTargetUrl":"https://lti-submission-{provider}.app.schoology.com/…"
 * Microsoft OneDrive = app 1078786112 on lti-submission-microsoft, Google Drive =
 * app 1073361950 on lti-submission-google (HKIS). The provider is read from the
 * host, so another school's install of the same apps (different app id) still
 * resolves.
 *
 * A student's copy opens through the grader's own "open in a new tab" URL:
 *   {launchUrl}&custom_parameters[in_edit_mode]=true&studentId={uid}
 * The teacher's browser runs the LTI launch and the app redirects to the
 * student's file (docs.google.com/…/d/{id}/edit for Drive). A blank studentId
 * opens the TEACHER'S TEMPLATE, so a link is never built without a uid.
 * See .claude/schoology-api-reference.md ("Opening a student's copy").
 */
import { parseSubmissionDate } from './parseGraderDocuments.js';

export const GOOGLE_DRIVE = 'google_drive';
export const ONEDRIVE = 'onedrive';
export const OTHER_APP = 'other';

const PROVIDER_BY_HOST = [
  [/^lti-submission-google\./i, GOOGLE_DRIVE],
  [/^lti-submission-microsoft\./i, ONEDRIVE],
];

/**
 * { appId, launchUrl, targetHost, provider } from an assignment page's HTML, or
 * null when the page has no LTI submission app.
 */
export function parseLtiSubmissionApp(html) {
  if (!html) return null;
  const text = String(html).replace(/\\\//g, '/');
  const launch = /"launchUrl":"(\/apps\/lti\/(\d+)\/run\/assignment\/[^"]*)"/.exec(text);
  const target = /"submissionsTargetUrl":"(https:\/\/[^"]+)"/.exec(text);
  if (!launch || !target) return null;
  let targetHost;
  try { targetHost = new URL(target[1]).host; } catch { return null; }
  const provider = PROVIDER_BY_HOST.find(([re]) => re.test(targetHost))?.[1] ?? OTHER_APP;
  return { appId: launch[2], launchUrl: launch[1], targetHost, provider };
}

/** The grader's open-in-new-tab URL for one student's copy, or null without a uid. */
export function studentOpenUrl(webBaseUrl, launchUrl, uid) {
  const id = String(uid ?? '');
  if (!launchUrl || !/^\d+$/.test(id)) return null;
  const base = String(webBaseUrl || '').replace(/\/+$/, '');
  const sep = launchUrl.includes('?') ? '&' : '?';
  return `${base}${launchUrl}${sep}custom_parameters[in_edit_mode]=true&studentId=${id}`;
}

/**
 * Google Drive links for the roster students in the grader's submitted list.
 * @param {Array<{id, submissionDate}>} submitted  submitted-documents entries
 * @param {Array<{schoology_uid}>} roster
 * @returns {Record<string, {url, provider, submittedAt: string|null}>} by uid
 */
export function driveLinksForSubmitted(submitted, roster, webBaseUrl, launchUrl) {
  const onRoster = new Set((roster ?? []).map((s) => String(s.schoology_uid)));
  const links = {};
  for (const entry of submitted ?? []) {
    const uid = entry?.id == null ? '' : String(entry.id);
    if (!onRoster.has(uid)) continue;
    const url = studentOpenUrl(webBaseUrl, launchUrl, uid);
    if (!url) continue;
    const epoch = parseSubmissionDate(entry.submissionDate);
    links[uid] = { url, provider: GOOGLE_DRIVE, submittedAt: epoch == null ? null : new Date(epoch * 1000).toISOString() };
  }
  return links;
}
