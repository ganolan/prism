// Spike (#142), read only: the grader's "open in a new tab" for an
// lti_submission student document. The assignment bundle builds it as
//   launchUrl + "&custom_parameters[in_edit_mode]=true" + "&studentId={uid}"
// (Assignment.getLtiSubmissionLaunchRedirectUrl + urlLauncher). This GETs that
// URL over plain HTTP with the saved session and reports the LTI launch form it
// returns (action host/path, field names, masked values). With LAUNCH=1 it then
// POSTs the form to the tool (an LTI sign-in, nothing is written) and follows
// redirects by hand, reporting each hop's host and masked path and any Google /
// Microsoft document reference in the final page.
//
// Usage: [LAUNCH=1] node scripts/probe-lti-student-launch.js <assignmentId> [studentUid | sub:N | inp:N]
//   Default sub:0 = the first student in submitted-documents.
import 'dotenv/config';
import { createHash } from 'crypto';
import { cookieJar, getPage, formFields } from '../server/services/schoologyWeb.js';
import { SCHOOLOGY_BASE } from '../server/lib/browserSession.js';

const aid = process.argv[2];
let uid = process.argv[3];
const jar = cookieJar();
const mask = (s) => String(s ?? '')
  .replace(/(file=)[^&"'\s]*/g, '$1<filename>')
  .replace(/(\/d\/)[A-Za-z0-9_-]+/g, '$1<fileId>')
  .replace(/[A-Za-z0-9_-]{20,}/g, (m) => `<${m.length}ch>`)
  .replace(/\b\d{6,}\b/g, (m) => `<${m.length}d>`);

const { html } = await getPage(jar, `/assignment/${aid}`);
const unesc = html.replace(/\\\//g, '/');
const launchUrl = unesc.match(/"launchUrl":"([^"]+)"/)?.[1];
console.log('launchUrl:', mask(launchUrl));
// studentUid may be a uid, or "sub:N" / "inp:N" = the Nth entry of the grader's
// submitted / in-progress list (so ids never need to be typed or printed).
const pick = /^(sub|inp):(\d+)$/.exec(uid || 'sub:0');
if (pick) {
  const list_ = pick[1] === 'sub' ? 'submitted-documents' : 'in-progress-documents';
  const r = await fetch(`${SCHOOLOGY_BASE}/iapi2/assignments/${aid}/${list_}/`, { headers: { cookie: jar.header(), Accept: 'application/json' } });
  const list = (await r.json())?.data ?? [];
  const e = list[Number(pick[2])];
  uid = String(e?.id ?? '');
  console.log(`${list_}: ${list.length}; entry ${pick[2]}: uid ${mask(uid)} revisionCreated=${e?.revisionCreated} submissionStatus=${e?.submissionStatus}`);
}
const sep = launchUrl.includes('?') ? '&' : '?';
const openUrl = `${launchUrl}${sep}custom_parameters[in_edit_mode]=true&studentId=${uid}`;
const launch = await getPage(jar, openUrl);
console.log('launch page:', mask(new URL(launch.url).pathname + new URL(launch.url).search), `${launch.html.length} bytes`);
const formId = launch.html.match(/<form[^>]*\sid="([^"]+)"/)?.[1];
const forms = [...launch.html.matchAll(/<form\b[^>]*>/g)].map((m) => m[0]);
console.log('forms:', forms.map((f) => mask(f.slice(0, 200))));
const fields = formId ? formFields(launch.html, formId) : null;
if (!fields) { console.log('no form with an id; head:', mask(launch.html.slice(0, 600))); process.exit(0); }
console.log('form action:', mask(fields.action));
for (const [k, v] of Object.entries(fields.inputs)) {
  const show = /^(lti_message_type|lti_version|oauth_signature_method|oauth_version|roles|launch_presentation_document_target|context_type|resource_link_title|ext_lms|tool_consumer_info_product_family_code)$/.test(k) || k.startsWith('custom_');
  console.log(`  ${k} = ${show ? mask(v).slice(0, 160) : `<${String(v).length}ch>`}`);
}

if (process.env.LAUNCH === '1') {
  const toolJar = new Map();
  const cookieHdr = () => [...toolJar].map(([k, v]) => `${k}=${v}`).join('; ');
  const take = (res) => {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';'); const i = pair.indexOf('=');
      if (i > 0) toolJar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  };
  let res = await fetch(fields.action, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: SCHOOLOGY_BASE, Referer: launch.url },
    body: new URLSearchParams({ ...fields.inputs, ...(fields.submit ? { [fields.submit.name]: fields.submit.value } : {}) }).toString(),
  });
  take(res);
  let url = fields.action;
  for (let hop = 0; hop < 8; hop++) {
    console.log(`hop ${hop}: ${res.status} ${new URL(url).host}${mask(new URL(url).pathname)} set-cookie=[${(res.headers.getSetCookie?.() ?? []).map((c) => c.split('=')[0]).join(',')}] location=${mask(res.headers.get('location') || '').slice(0, 200)}`);
    const loc = res.headers.get('location');
    if (![301, 302, 303, 307, 308].includes(res.status) || !loc) break;
    url = new URL(loc, url).href;
    if (!/schoology\.com$/.test(new URL(url).host)) {
      const id = url.match(/\/d\/([A-Za-z0-9_-]+)/)?.[1] || url.match(/sourcedoc=([^&]+)/)?.[1];
      if (id) console.log(`  file id: ${id.length} chars, sha1 ${createHash('sha1').update(id).digest('hex').slice(0, 8)}`); console.log(`  → leaves the tool: ${new URL(url).host}${mask(new URL(url).pathname)}${mask(new URL(url).search).slice(0, 200)}`); break; }
    res = await fetch(url, { redirect: 'manual', headers: { cookie: cookieHdr() } });
    take(res);
  }
  const body = await res.text().catch(() => '');
  console.log(`final body ${body.length} bytes`);
  for (const m of body.matchAll(/https:\/\/(docs|drive)\.google\.com\/[^"'\s<>\\]{0,160}|sharepoint\.com\/[^"'\s<>\\]{0,160}|"(fileId|documentId|driveId|file_id|document_id|documentUrl|url)"\s*:\s*"[^"]{0,160}"/g)) {
    console.log('  ref:', mask(m[0]));
  }
  if (process.env.DUMP) console.log(mask(body.slice(0, 3000)));
}
