#!/usr/bin/env node
// Read-only probe (2026-10-08, student-history spec): list the teacher's
// archived sections from Schoology's past-courses page (browser session).
// Usage: PRISM_SESSION_DIR=<dir> node scripts/probe-archived-inventory.js [titleFilter]
import { fetchArchivedCoursesHtml } from '../server/services/archivedCourses.js';
import { parsePastCourses } from '../server/lib/parsePastCourses.js';

const filter = (process.argv[2] || '').toLowerCase();
const html = await fetchArchivedCoursesHtml();
if (!html) { console.log('no html (no session / expired / launch failed)'); process.exit(1); }
const rows = parsePastCourses(html);
console.log(`${rows.length} archived sections`);
for (const r of rows) {
  const line = JSON.stringify(r);
  if (!filter || line.toLowerCase().includes(filter)) console.log(line);
}
