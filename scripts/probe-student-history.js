#!/usr/bin/env node
// Read-only probe for the student-history spec (2026-10-08): which Schoology
// sections a student is in now, and whether they appear (any status) in a
// given list of sections. GETs only. Usage:
//   node --env-file=<.env> scripts/probe-student-history.js <uid> [sectionId ...]
import { apiGet } from '../server/services/schoology.js';

const [uid, ...sectionIds] = process.argv.slice(2);
const out = {};
try {
  const r = await apiGet(`/users/${uid}/sections`);
  out.userSections = (r?.section || []).map((s) => ({ id: s.id, course_title: s.course_title, section_title: s.section_title, active: s.active, grading_periods: s.grading_periods }));
} catch (e) { out.userSectionsError = String(e.message || e); }
for (const sid of sectionIds) {
  try {
    const sec = await apiGet(`/sections/${sid}`);
    const enr = await apiGet(`/sections/${sid}/enrollments?limit=200`);
    const hit = (enr?.enrollment || []).filter((e) => String(e.uid) === String(uid));
    out[sid] = { title: `${sec?.course_title} ${sec?.section_title}`, active: sec?.active, enrolments: (enr?.enrollment || []).length, statuses: (enr?.enrollment || []).reduce((m, e) => ({ ...m, [`${e.status}/admin${e.admin}`]: (m[`${e.status}/admin${e.admin}`] || 0) + 1 }), {}), student: hit.map((e) => ({ status: e.status, admin: e.admin, name: e.name_display })) };
  } catch (e) { out[sid] = { error: String(e.message || e) }; }
}
console.log(JSON.stringify(out, null, 2));
