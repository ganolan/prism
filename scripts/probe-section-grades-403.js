#!/usr/bin/env node
// Read-only probe: why does a past section answer 403 on its grades? (course 1096, 24 Oct 2026)
// Prints status codes, field names and counts only, never student data.
// Usage: node scripts/probe-section-grades-403.js <sectionId> [compareSectionId]
import 'dotenv/config';
import OAuth from 'oauth-1.0a';

const API = `${process.env.SCHOOLOGY_BASE_URL}/v1`;
const oauth = OAuth({
  consumer: { key: process.env.SCHOOLOGY_CONSUMER_KEY, secret: process.env.SCHOOLOGY_CONSUMER_SECRET },
  signature_method: 'PLAINTEXT',
});

async function get(path) {
  let url = `${API}${path}`;
  for (let i = 0; i < 5; i++) {
    const res = await fetch(url, { headers: { ...oauth.toHeader(oauth.authorize({ url, method: 'GET' }, { key: '', secret: '' })), Accept: 'application/json' }, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(res.status)) { url = new URL(res.headers.get('location'), url).href; continue; }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text: text.slice(0, 200) };
  }
  return { status: 'redirect loop' };
}

const [id, compare] = process.argv.slice(2);
for (const sid of [id, compare].filter(Boolean)) {
  console.log(`\n== section ${sid}`);
  const sec = await get(`/sections/${sid}`);
  console.log('section', sec.status, sec.json ? Object.entries(sec.json).filter(([k, v]) => typeof v !== 'object').map(([k, v]) => `${k}=${['id', 'course_id', 'active', 'section_title', 'grading_periods', 'synced', 'admin', 'school_id', 'building_id', 'course_title', 'parent_id', 'linked'].includes(k) ? v : '…'}`).join(' ') : sec.text);
  const g = await get(`/sections/${sid}/grades`);
  console.log('grades', g.status, g.json ? `keys=${Object.keys(g.json)} rows=${g.json?.grades?.grade?.length ?? 0}` : g.text);
  const gp = await get(`/sections/${sid}/grading_periods`);
  console.log('grading_periods', gp.status, gp.text.slice(0, 120).replace(/"title":"[^"]*"/g, '"title":"…"'));
  const a = await get(`/sections/${sid}/assignments?limit=20`);
  const tasks = a.json?.assignment ?? [];
  console.log('assignments', a.status, `n=${tasks.length}`);
  for (const t of tasks.slice(0, 5)) {
    const tg = await get(`/sections/${sid}/grades?assignment_id=${t.id}`);
    console.log(`  task ${t.id} grading_period=${t.grading_period} grades`, tg.status, tg.json ? `rows=${tg.json?.grades?.grade?.length ?? 0}` : tg.text.slice(0, 80));
  }
  const e = await get(`/sections/${sid}/enrollments?limit=5`);
  console.log('enrollments', e.status, `n=${e.json?.enrollment?.length ?? 0} admin=${(e.json?.enrollment ?? []).filter((x) => x.admin == 1).length}`);
}

// Whose rows: the teacher's own enrolment and role, and whether the per-task rows are the teacher's.
const meJson = (await get('/users/me')).json;
const me = meJson?.id ?? meJson?.uid;
console.log(`\nteacher uid ${me}`);
for (const sid of [id, compare].filter(Boolean)) {
  const e = (await get(`/sections/${sid}/enrollments?limit=200`)).json?.enrollment ?? [];
  const mine = e.find((x) => String(x.uid) === String(me));
  console.log(`${sid}: ${e.length} enrolments (${e.filter((x) => x.admin == 1).length} admin); teacher ${mine ? `enrolled admin=${mine.admin} status=${mine.status}` : 'not enrolled'}`);
  const byEnrol = new Map(e.map((x) => [String(x.id), x]));
  const t = (await get(`/sections/${sid}/assignments?limit=1`)).json?.assignment?.[0];
  if (t) {
    const rows = (await get(`/sections/${sid}/grades?assignment_id=${t.id}`)).json?.grades?.grade ?? [];
    console.log(`  task ${t.id}: ${rows.length} rows; ${rows.map((r) => { const x = byEnrol.get(String(r.enrollment_id)); return x ? (String(x.uid) === String(me) ? 'teacher' : x.admin == 1 ? 'other admin' : 'student') : 'unknown enrolment'; }).join(', ')}`);
  }
}

// Does the teacher's section list carry the role? Which listed sections is the teacher not an admin of?
const list = (await get(`/users/${me}/sections?include_past=1`)).json?.section ?? [];
console.log(`\nlist: ${list.length} sections; row has admin field: ${list.some((s) => 'admin' in s)}`);
const notAdmin = list.filter((s) => String(s.admin) !== '1');
console.log(`admin != 1: ${notAdmin.length}`, notAdmin.map((s) => `${s.id} ${s.course_title} ${s.section_title} active=${s.active} admin=${s.admin}`).join(' | '));
