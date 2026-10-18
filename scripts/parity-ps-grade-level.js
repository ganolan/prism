#!/usr/bin/env node
// Parity probe (#164, read only): grade level from the section student list
// (GET /ws/pt/v1/section/{psmSectionId}/students_integration, joined through
// getStudentsInSection.json) against the old read (GET /ws/attendance/section_attendance
// over ~15 in-session days), for every active course in the database at DB_PATH.
// Both over plain HTTP on the attendance LTI session (server/services/powerschoolWeb.js).
//
// Prints counts and timings only: never a name, an id or a student's grade.
// Point DB_PATH at a copy (sqlite3 … ".backup …"), never the prod database; this
// script only reads it.
//
// Usage: node --env-file=.env scripts/parity-ps-grade-level.js [parity|sync]
//   parity (default) — compare the two reads per section, with per-read timings;
//   sync — run syncPsAttendance once (block + grade-level pass, WRITES the DB at
//          DB_PATH, so a copy only) and print its wall time and grade-level summary.
import Database from 'better-sqlite3';
import { cookieJar } from '../server/services/schoologyWeb.js';
import { PowerSchoolWeb } from '../server/services/powerschoolWeb.js';
import { readSectionInfo, readStudentListGrades, readAttendanceGrades } from '../server/services/psGradeLevelRead.js';

const mode = process.argv[2] || 'parity';
const dbPath = process.env.DB_PATH;
if (!dbPath || /\/prism\/data\/students\.db$/.test(dbPath)) {
  console.error('Set DB_PATH to a copy of the database (not ~/prism/data/students.db).');
  process.exit(1);
}

if (mode === 'sync') {
  const { syncPsAttendance } = await import('../server/services/psAttendanceSync.js');
  const t = Date.now();
  const r = await syncPsAttendance({ onProgress: () => {} });
  console.log(JSON.stringify({ ms: Date.now() - t, processed: r.processed, updated: r.updated, unchanged: r.unchanged, skipped: r.skipped, gradeLevels: r.gradeLevels, reasons: r.results.map((x) => x.reason) }));
  process.exit(0);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const courses = db.prepare(`SELECT id, schoology_section_id FROM courses
  WHERE excluded = 0 AND archived = 0 AND schoology_section_id IS NOT NULL ORDER BY course_name`).all();
const prismUids = new Set(db.prepare('SELECT school_uid FROM students WHERE school_uid IS NOT NULL').all().map((r) => r.school_uid));
const storedGrad = new Map(db.prepare('SELECT school_uid, grad_year FROM students WHERE grad_year IS NOT NULL').all().map((r) => [r.school_uid, r.grad_year]));

const sgyJar = cookieJar();
if (!sgyJar) { console.error('No saved Schoology session (PRISM_SESSION_DIR/storage-state.json).'); process.exit(1); }
const ps = new PowerSchoolWeb({ sgyJar });
const today = new Date().toISOString().slice(0, 10);
const timed = async (fn) => { const t = Date.now(); const v = await fn(); return [v, Date.now() - t]; };
const total = { sections: 0, both: 0, newStudents: 0, oldStudents: 0, matched: 0, mismatched: 0, onlyNew: 0, onlyOld: 0, inPrism: 0, newMs: 0, oldMs: 0, infoMs: 0, unjoined: 0, noGrade: 0 };
const yearEnd = new Date().getMonth() >= 7 ? new Date().getFullYear() + 1 : new Date().getFullYear();
let storedAgree = 0; let storedDiffer = 0;

console.log(`${courses.length} active courses; today ${today}`);
for (const [i, c] of courses.entries()) {
  const label = `course ${i + 1}`;
  const { sectionDcid, form } = await ps.launchIds(c.schoology_section_id);
  if (!sectionDcid) { console.log(`${label}: no PowerSchool section, skipped`); continue; }
  const userDcid = String(form?.fields?.custom_userdcid || '').split('_').pop() || null;
  if (!ps.launched) { const [, ms] = await timed(() => ps.launch(c.schoology_section_id)); console.log(`PowerSchool session started (${ms} ms)`); }
  total.sections++;
  const [info, infoMs] = await timed(() => readSectionInfo(ps, sectionDcid, today));
  let fresh; let old; let newMs = 0; let oldMs = 0;
  try { [fresh, newMs] = await timed(() => readStudentListGrades(ps, { sectionDcid, psmSectionId: info?.psmSectionId })); } catch (err) { console.log(`${label}: student list failed (${err.message})`); }
  try { [old, oldMs] = await timed(() => readAttendanceGrades(ps, { sectionDcid, userDcid, sectionInfo: info, today })); } catch (err) { console.log(`${label}: section_attendance failed (${err.message})`); }
  if (!fresh || !old) continue;
  total.both++;
  const a = new Map(fresh.grades.map((g) => [g.dcid, g.gradeLevel]));
  const b = new Map(old.map((g) => [g.dcid, g.gradeLevel]));
  let matched = 0; let mismatched = 0; let onlyNew = 0; let onlyOld = 0;
  for (const [dcid, g] of a) { if (!b.has(dcid)) onlyNew++; else if (b.get(dcid) === g) matched++; else mismatched++; }
  for (const dcid of b.keys()) if (!a.has(dcid)) onlyOld++;
  const inPrism = [...a.keys()].filter((d) => prismUids.has(`1_${d}`)).length;
  for (const [dcid, g] of a) {
    const stored = storedGrad.get(`1_${dcid}`);
    if (stored == null) continue;
    if (stored === yearEnd + (12 - g)) storedAgree++; else storedDiffer++;
  }
  Object.assign(total, {
    newStudents: total.newStudents + a.size, oldStudents: total.oldStudents + b.size,
    matched: total.matched + matched, mismatched: total.mismatched + mismatched,
    onlyNew: total.onlyNew + onlyNew, onlyOld: total.onlyOld + onlyOld, inPrism: total.inPrism + inPrism,
    newMs: total.newMs + newMs, oldMs: total.oldMs + oldMs, infoMs: total.infoMs + infoMs,
    unjoined: total.unjoined + fresh.unjoined, noGrade: total.noGrade + fresh.noGrade,
  });
  console.log(`${label}: list ${fresh.listed} (${fresh.grades.length} joined, ${fresh.unjoined} unjoined, ${fresh.noGrade} no grade) in ${newMs} ms; section_attendance ${b.size} in ${oldMs} ms; match ${matched}, mismatch ${mismatched}, only list ${onlyNew}, only attendance ${onlyOld}; in Prism ${inPrism}; section_info ${infoMs} ms`);
}
console.log(`TOTAL ${JSON.stringify(total)}`);
console.log(`stored grad_year vs the list: agree ${storedAgree}, differ ${storedDiffer}`);
