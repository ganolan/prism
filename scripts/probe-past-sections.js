#!/usr/bin/env node
// Read-only probe (2026-10-08, student-history spec): does REST
// GET /users/{uid}/sections accept include_past=1 and return archived
// sections? GETs only. Usage:
//   node --env-file=<.env> scripts/probe-past-sections.js <uid|me> [titleFilter]
import { apiGet } from '../server/services/schoology.js';
import { getMyUserId } from '../server/services/schoology.js';

let [uid, filter] = process.argv.slice(2);
if (uid === 'me') uid = await getMyUserId();
const summarize = (r) => (r?.section || []).map((s) => `${s.id} | ${s.course_title} ${s.section_title} | active=${s.active} | gp=${(s.grading_periods || []).join(',')}`)
  .filter((l) => !filter || l.toLowerCase().includes(filter.toLowerCase()));
for (const q of ['', '?include_past=1', '?include_past=1&limit=200']) {
  try {
    const r = await apiGet(`/users/${uid}/sections${q}`);
    const rows = summarize(r);
    console.log(`\n== /users/${uid}/sections${q}: total=${r?.total ?? '?'} section[]=${(r?.section || []).length} shown=${rows.length} links=${JSON.stringify(r?.links ?? null)}`);
    rows.forEach((l) => console.log('  ' + l));
  } catch (e) { console.log(`${q}: ERROR ${e.message || e}`); }
}
