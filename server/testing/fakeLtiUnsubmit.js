// Test-only: Schoology's side of the LTI unsubmit (server/services/ltiUnsubmit.js) over
// plain HTTP, on fakeSchoologyWeb. Never reaches the network.
// page / post / inProgress: a fakeSchoologyWeb route spec, or (entry) => spec. Defaults:
// the assignment page carrying the CSRF pair, the verified 200 {"data":[]}, and an
// in-progress list holding `uid`.
import { fakeSchoologyWeb } from './fakeSchoologyWeb.js';

export const SCHOOLOGY = 'https://schoology.hkis.edu.hk';

export const assignmentPage = (csrf = { csrf_token: 'tok', csrf_key: 'key' }) => `<html><head>
<script type="text/javascript">
<!--//--><![CDATA[//><!--
jQuery.extend(Drupal.settings, ${JSON.stringify({ basePath: '/', s_common: csrf })});
//--><!]]>
</script></head><body></body></html>`;

export function fakeLtiUnsubmit({ uid, aid, csrf, page, post, inProgress } = {}) {
  const id = /^\d+$/.test(String(uid)) ? Number(uid) : uid;
  return fakeSchoologyWeb({ routes: {
    [`/assignments/${aid}/info`]: page ?? { text: assignmentPage(csrf) },
    [`POST /iapi2/assignments/${aid}/submission-action/${uid}`]: post ?? { json: { data: [] } },
    [`/iapi2/assignments/${aid}/in-progress-documents/`]: inProgress ?? { json: { data: [{ id, revisionCreated: true }] } },
  } });
}
