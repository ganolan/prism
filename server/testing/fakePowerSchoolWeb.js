// A stand-in for the Schoology attendance LTI launch and PowerSchool's MBA alert
// reads (server/services/powerschoolWeb.js, psAlertsSync.js), and the grade-level
// reads (psGradeLevelRead.js, #164): section_info, the section student list
// (/ws/pt/v1/section/{psmSectionId}/students_integration) and section_attendance.
// Shapes follow the live answers recorded in .claude/powerschool-api-reference.md
// "Student alerts (#117)" and "Student grade level, gender and postal address
// (#116)"; every value is made up. Records every request; never reaches the network.
const PS = 'https://powerschool.hkis.edu.hk';

export const launchHtml = ({ sectionDcid = '9001', action = `${PS}/integrations/attendance/index.html` } = {}) => `<html><body>
<form action="${action}" method="post" id="ltiLaunchForm" name="ltiLaunchForm">
<input type="hidden" name="lti_message_type" value="basic-lti-launch-request" />
<input type="hidden" name="custom_sectiondcid" value="${sectionDcid}" />
<input type="hidden" name="custom_userdcid" value="2_100" />
<input type="hidden" name="oauth_signature" value="sig&amp;=" />
</form><script>document.forms[0].submit()</script></body></html>`;

const sf = (id, field, operator, operand = '') => ({
  id, trigger_type: 'sf', disabled: '0', name: `alert ${id}`, student_field: `U_Students_Extension.${field}`,
  ext_table_name: 'U_DEF_EXT_STUDENTS', student_field_operator: operator, student_field_operand: operand,
  querystring: '', trigger_url: '', stub_url: '',
});
export const CATALOGUE = [
  sf('10593860', 'X_SPP', 'notblank'),
  sf('10593862', 'X_LS_SUPPORT_LEVEL', 'in', '1'),
  sf('10593828', 'X_ALLERGYEPI', 'in', '1'),
  sf('10672509', 'X_DNC_G1', 'notblank'),
  sf('32012479', 'X_HomeEmail', 'in', '1'),
  { id: '10593855', trigger_type: 'adv', disabled: '0', name: 'Allergies', trigger_url: 'allergies.html', querystring: '' },
  { id: '39472338', trigger_type: 'man', disabled: '0', name: 'Mobility', trigger_url: '', querystring: '' },
  {},
];

// sections: { [sectionDcid]: [{ studentid, studentdcid, values: {field: value}, adv: [alert ids], man: [alert ids] }] }
//   gradeLevel (integer), photoURL? (overrides the list's /teachers/stpnormal/{studentid}ph.jpeg)
// schoology: { [schoologySectionId]: sectionDcid | null }
// sectionInfo: { [sectionDcid]: section_info[0] } (default: psmSectionId "P{sectionDcid}", a few in-session days)
export function fakePowerSchoolWeb({
  schoology = { S1: '9001' }, sections = {}, catalogue = CATALOGUE, sectionInfo = {},
  loginRedirect = false, launchStatus = 200, failRead, expireOnce,
} = {}) {
  const requests = [];
  let launches = 0;
  let expired = false;
  const answer = (status, body, headers = {}) => new Response(body, { status, headers });
  const json = (v) => answer(200, JSON.stringify(v), { 'content-type': 'application/json;charset=UTF-8' });
  const params = (u, opts) => (opts.method === 'POST' ? new URLSearchParams(opts.body) : u.searchParams);
  async function fetchImpl(url, opts = {}) {
    const u = new URL(url);
    const method = opts.method || 'GET';
    const entry = { method, host: u.host, path: u.pathname, cookie: opts.headers?.cookie || '', accept: opts.headers?.Accept || '' };
    requests.push(entry);
    const run = u.pathname.match(/^\/apps\/lti\/\d+\/run\/course\/(.+)$/);
    if (run) {
      if (loginRedirect) return answer(302, '', { location: 'https://login.microsoftonline.com/x' });
      const dcid = schoology[run[1]];
      return answer(200, dcid === undefined ? '<html>no app</html>' : launchHtml({ sectionDcid: dcid ?? '' }));
    }
    if (u.host !== new URL(PS).host) return answer(404, 'not faked');
    if (u.pathname === '/integrations/attendance/index.html' && method === 'POST') {
      launches++;
      expired = false;
      entry.form = Object.fromEntries(new URLSearchParams(opts.body));
      return answer(launchStatus, '<html>app</html>', { 'set-cookie': `JSESSIONID=s${launches}; Path=/; HttpOnly` });
    }
    if (!entry.cookie.includes('JSESSIONID=') || expired) return answer(302, '', { location: `${PS}/teachers/pw.html` });
    const name = u.pathname.split('/').pop();
    const p = params(u, opts);
    entry.params = Object.fromEntries(p);
    if (failRead?.(name, entry)) return answer(500, 'boom');
    if (expireOnce && expireOnce === name) {
      expireOnce = null; expired = true;
      return answer(302, '', { location: `${PS}/teachers/pw.html` });
    }
    // /ws/pt/v1 answers 500 ("no message body writer") unless asked for JSON alone.
    if (u.pathname.startsWith('/ws/pt/v1/') && entry.accept !== 'application/json') return answer(500, 'no message body writer');
    if (u.pathname === '/ws/attendance/section_info') {
      const dcid = p.get('sectionDcid');
      const days = { '2026-10-12': { inSession: true }, '2026-10-13': { inSession: true }, '2026-10-14': { inSession: false }, '2026-10-15': { inSession: true } };
      return json([sectionInfo[dcid] ?? { psmSectionId: `P${dcid}`, calenderDays: days, bellScheduleItems: [] }]);
    }
    const psm = u.pathname.match(/^\/ws\/pt\/v1\/section\/([^/]+)\/students_integration$/);
    if (psm) {
      const dcid = Object.keys(sections).find((d) => `P${d}` === psm[1] || sectionInfo[d]?.psmSectionId === psm[1]);
      const students = (sections[dcid] || []).map((st, i) => ({
        id: `M${i}${st.studentid}`, firstName: 'X', lastName: 'Y', gender: 'F',
        photoURL: st.photoURL ?? `/teachers/stpnormal/${st.studentid}ph.jpeg`,
        gradeLevel: st.gradeLevel == null ? '' : String(st.gradeLevel).padStart(2, '0'),
      }));
      return json({ 'student-list': { students } });
    }
    if (u.pathname === '/ws/attendance/section_attendance') {
      const roster = (sections[p.get('sectionDcid')] || []).map((st) => ({
        studentId: Number(st.studentid), dcid: Number(st.studentdcid), gradeLevel: st.gradeLevel, lastName: 'Y', firstName: 'X',
      }));
      // One entry per meeting day in the range, each repeating the roster.
      return json({ sectionAttendances: [{ studentAttendance: roster }, { studentAttendance: roster }], studentAlerts: [] });
    }
    if (name === 'getAlertTypes.json') return json(catalogue);
    if (name === 'getStudentsInSection.json') {
      const rows = (sections[p.get('sectionIds')] || []).map((s) => ({ ccid: '1', sectionid: p.get('sectionIds'), lastfirst: 'X', studentid: s.studentid, studentdcid: s.studentdcid }));
      return json([...rows, {}]);
    }
    const all = Object.values(sections).flat();
    const listed = new Set(String(p.get('stuList') || p.get('studentIds') || '').split(','));
    if (name === 'stuFieldValues.json') {
      const fields = [...p.entries()].filter(([k]) => /^field\d+$/.test(k)).map(([, v]) => v);
      const recs = all.filter((s) => listed.has(String(s.studentid))).map((s) => ({
        id: Number(s.studentid), dcid: Number(s.studentdcid),
        ...Object.fromEntries(fields.map((f) => [f, s.values?.[f] ?? null])),
      }));
      return json([...recs, {}]);
    }
    if (name === 'getAdvTriggerMatches.html') {
      const type = catalogue.find((t) => t.trigger_url === p.get('trigger_url'));
      const hit = Object.fromEntries(all.filter((s) => listed.has(String(s.studentid)) && s.adv?.includes(type?.id)).map((s) => [s.studentid, 'x']));
      return answer(200, JSON.stringify({ ...hit, '-1': '' }), { 'content-type': 'text/html;charset=UTF-8' });
    }
    if (name === 'getAlerts.json') {
      const rows = all.filter((s) => listed.has(String(s.studentid))).flatMap((s) => (s.man || []).map((id) => ({ id: `m${s.studentid}`, u_aet_customalerts_typesid: id, studentsdcid: s.studentdcid })));
      return json([...rows, {}]);
    }
    return answer(404, 'not faked');
  }
  const jar = { header: () => 'SESS=sgy', take() {} };
  return { requests, fetchImpl, jar, launches: () => launches };
}
