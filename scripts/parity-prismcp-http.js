// Parity check for PrisMCP over HTTP (#131): every READ tool, called two ways with the same
// arguments against the same database copy, must answer the same.
//
//   direct  the tools exactly as the stdio process builds them (mcp/server.js createServer(),
//           handlers on getDb() of --db), reached over an in-memory MCP transport
//   http    the Prism server's /mcp (server/routes/mcp.js), over the MCP SDK's HTTP client
//
// Run (see docs/prismcp-install-and-verify.md): copy the database with the SQLite backup API,
// start a dev server on the copy (`DB_PATH=<copy> PORT=3002 npm run dev:server`), then
//   node scripts/parity-prismcp-http.js --url http://127.0.0.1:3002/mcp --db <copy>
// One line per tool call: `same` or the differing paths. Exit 1 on any difference.
//
// Never point --db at the live database: use a copy made with `sqlite3 <db> ".backup <copy>"`.
//
// Output holds real student data (it prints only the tool, the verdict and differing PATHS, never
// an answer). Keep the output out of git and delete the copy when done.
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { isMain } from '../server/lib/isMain.js';

// ---- the comparison -------------------------------------------------------------------------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const matches = (rule, key) => (rule instanceof RegExp ? rule.test(key) : rule === key);

// Paths of the leaves where `a` and `b` differ. `ignore`: key names (string or RegExp), skipped
// at any depth on either side. A value whose type differs (object / array / scalar / null) is
// reported at the value itself. Root differences are reported as `$`.
export function diffAnswers(a, b, { ignore = [] } = {}) {
  const out = [];
  const skip = (key) => ignore.some((rule) => matches(rule, key));
  const walk = (x, y, path) => {
    if (Array.isArray(x) && Array.isArray(y)) {
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if (i >= x.length || i >= y.length) out.push(`${path}[${i}]`);
        else walk(x[i], y[i], `${path}[${i}]`);
      }
    } else if (isObj(x) && isObj(y)) {
      const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => !skip(k));
      for (const k of keys) {
        const child = path === '$' ? k : `${path}.${k}`;
        if (!(k in x) || !(k in y)) out.push(child);
        else walk(x[k], y[k], child);
      }
    } else if (!Object.is(x, y)) {
      out.push(path);
    }
  };
  walk(a, b, '$');
  return out;
}

// ---- exceptions: each with its reason --------------------------------------------------------
// An exception only ever hides a path that really differs, and every use is printed with its
// reason, so none can silently make a difference disappear.
const EXCEPTIONS = [
  {
    rule: 'data_as_of',
    reason: 'a timestamp of when the answer was assembled; two calls moments apart read it at different times',
  },
  {
    rule: /_source$/,
    reason: 'names the live source (a sync or the stored copy) the answer drew on, which can differ between the two processes',
  },
];
// Not an ignore rule: the dev server leads every result with this warning (mcp/server.js
// DEV_COPY_WARNING), which the direct side, a non-dev server, does not have. It is dropped from
// the http side only when it really is the first item, once per call, and counted.
const DEV_WARNING_REASON = 'a dev server leads every tool result with the dev-copy warning; the direct side is not a dev server';

// Read tools NOT compared, each with its reason. Every other tool in the server is a writer.
export const EXCLUDED_READS = [
  ['preview_status_line', 'reads the live Schoology comment thread'],
  ['get_support_summary', 'reads the live PowerSchool Student Support Summary'],
  ['load_quiz_results', 'queues a Schoology sync run (a read from Schoology, and writes the stored results)'],
];

// ---- running the cases -----------------------------------------------------------------------

// An answer as comparable data: each text item parsed as JSON when it is JSON.
function normalise(result, { dropDevWarning, warning }) {
  let content = result.content || [];
  let dropped = 0;
  if (dropDevWarning && content[0]?.type === 'text' && content[0].text === warning) {
    content = content.slice(1);
    dropped = 1;
  }
  const items = content.map((c) => {
    if (c.type !== 'text') return c;
    try { return JSON.parse(c.text); } catch { return c.text; }
  });
  return { answer: { isError: Boolean(result.isError), content: items }, dropped };
}

async function call(client, name, args) {
  try {
    return await client.callTool({ name, arguments: args });
  } catch (err) {
    // A protocol-level rejection (bad arguments, unknown tool) is an answer too.
    return { isError: true, content: [{ type: 'text', text: `PROTOCOL: ${err.message}` }] };
  }
}

function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return { url: get('--url'), db: get('--db') };
}

// The arguments come from the copy: the first current course, its newest graded assignment, a
// student, a quiz group and a rubric. A missing kind of data is reported as skipped, not as same.
export function pickArguments(db, listCourses) {
  const courses = listCourses(db, {});
  const withGrade = (courseId) => db.prepare(
    `SELECT a.id, a.schoology_assignment_id FROM assignments a
     JOIN grades g ON g.assignment_id = a.id AND g.score IS NOT NULL
     WHERE a.course_id = ?
     GROUP BY a.id ORDER BY (a.due_date IS NULL), a.due_date DESC, a.id DESC LIMIT 1`,
  ).get(courseId);
  const course = courses.find((c) => withGrade(c.id)) || courses[0];
  const assignment = course ? withGrade(course.id) : undefined;
  const student = course ? db.prepare(
    `SELECT s.id, s.last_name FROM students s JOIN enrolments e ON e.student_id = s.id
     WHERE e.course_id = ? AND e.dropped_at IS NULL ORDER BY s.id LIMIT 1`,
  ).get(course.id) : undefined;
  const group = db.prepare(
    `SELECT g.id, g.course_id FROM quiz_groups g ORDER BY (g.loaded_at IS NULL), g.id LIMIT 1`,
  ).get();
  let tag;
  if (group) {
    for (const row of db.prepare('SELECT tags_json FROM quiz_questions WHERE group_id = ?').all(group.id)) {
      try { tag = JSON.parse(row.tags_json)[0]; } catch { /* untagged */ }
      if (tag) break;
    }
  }
  const rubric = db.prepare('SELECT name FROM rubrics ORDER BY id LIMIT 1').get();
  return { course, assignment, student, group, tag, rubric };
}

// The quiz tools. When the copy holds no quiz group (a database that has not linked any tests),
// they are still called, with a course for the listing and a group id that does not exist, so what
// is compared is the empty list and the error answer, labelled "no group in the copy"; the answer
// for real quiz data is then NOT covered, and the run says so.
function quizCases(p) {
  const g = p.group;
  const note = g ? '' : ' (no group in the copy)';
  const courseId = g?.course_id ?? p.course?.id;
  const groupId = g?.id ?? 999999;
  const tag = p.tag ?? 'CRD-2.G';
  return [
    [`list_quiz_groups${note}`, 'list_quiz_groups', courseId ? { course: courseId } : null],
    [`get_tag_results${note}`, 'get_tag_results', courseId ? { course: courseId, tag } : null],
    [`get_frq_responses${note}`, 'get_frq_responses', { group_id: groupId }],
    [`list_frq_writebacks${note}`, 'list_frq_writebacks', { group_id: groupId }],
    [`get_quiz_results${note}`, 'get_quiz_results', { group_id: groupId }],
  ];
}

// [label, tool, args] per case; null args mean the copy had no data to call it with.
export function buildCases(p) {
  const c = p.course?.id;
  const needs = (ok, args) => (ok ? args : null);
  return [
    ['list_courses', 'list_courses', {}],
    ['list_courses (archived)', 'list_courses', { include_archived: true }],
    ['list_assignments', 'list_assignments', needs(c, { course_id: c })],
    ['list_students', 'list_students', needs(c, { course_id: c })],
    ['list_students (dropped)', 'list_students', needs(c, { course_id: c, include_dropped: true })],
    ['get_assignment_context', 'get_assignment_context',
      needs(c && p.assignment, { course_id: c, assignment_id: p.assignment?.schoology_assignment_id, use_stored_data: true })],
    ['get_triage', 'get_triage', {}],
    ['get_triage (course, student)', 'get_triage', needs(c && p.student, { course: c, student: p.student?.id })],
    ['get_submission_status', 'get_submission_status', needs(c, { course: c })],
    ['get_submission_status (assignment, all)', 'get_submission_status',
      needs(p.assignment, { assignment_id: p.assignment?.id, status: 'all' })],
    ['list_referrals', 'list_referrals', {}],
    ['list_resubmissions', 'list_resubmissions', {}],
    ['school_calendar', 'school_calendar', { date: '2026-10-20', to: '2026-11-20' }],
    ['find_student', 'find_student', needs(p.student, { query: p.student?.last_name })],
    ['get_student_history', 'get_student_history', needs(p.student, { student: p.student?.id, limit: 5 })],
    ...quizCases(p),
    ['list_rubrics', 'list_rubrics', {}],
    ['read_rubric', 'read_rubric', needs(p.rubric, { name: p.rubric?.name })],
  ];
}

// Pair of answers → { verdict lines } — pure, so the report format is testable.
export function judge(direct, http) {
  const strict = diffAnswers(direct, http);
  const ignore = EXCEPTIONS.map((e) => e.rule);
  const real = diffAnswers(direct, http, { ignore });
  const excused = strict.filter((p) => !real.includes(p));
  const reasons = EXCEPTIONS
    .filter((e) => excused.some((p) => matches(e.rule, p.split(/[.[\]]/).filter(Boolean).pop())))
    .map((e) => `${e.rule}: ${e.reason}`);
  return { real, excused, reasons };
}

async function main() {
  const { url, db: dbArg } = parseArgs(process.argv.slice(2));
  if (!url || !dbArg) {
    console.error('usage: node scripts/parity-prismcp-http.js --url http://127.0.0.1:3002/mcp --db <copy of the database>');
    process.exit(2);
  }
  const dbPath = resolve(dbArg);
  if (!existsSync(dbPath)) {
    console.error(`parity: no database at ${dbPath}`);
    process.exit(2);
  }
  // server/db/index.js reads DB_PATH at import time: set it first, import the server after.
  process.env.DB_PATH = dbPath;
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { createServer, connectDb, DEV_COPY_WARNING } = await import('../mcp/server.js');
  const { listCourses } = await import('../mcp/handlers.js');

  const db = connectDb();
  const direct = new Client({ name: 'parity-direct', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([createServer().connect(serverSide), direct.connect(clientSide)]);
  const http = new Client({ name: 'parity-http', version: '1.0.0' });
  await http.connect(new StreamableHTTPClientTransport(new URL(url)));

  const args = pickArguments(db, listCourses);
  console.log(`database ${dbPath}; /mcp ${url}`);
  console.log(`arguments from the copy: course ${args.course ? 'yes' : 'NONE'}, graded assignment ${args.assignment ? 'yes' : 'NONE'}, `
    + `student ${args.student ? 'yes' : 'NONE'}, quiz group ${args.group ? 'yes' : 'NONE'}, tag ${args.tag ? 'yes' : 'NONE'}, rubric ${args.rubric ? 'yes' : 'NONE'}`);
  for (const [tool, why] of EXCLUDED_READS) console.log(`excluded  ${tool}: ${why}`);
  console.log(`exception  dev-copy warning item (first content item of every /mcp result, dropped when present): ${DEV_WARNING_REASON}`);
  for (const e of EXCEPTIONS) console.log(`exception  ${e.rule}: ${e.reason} (applied only where the value really differs)`);

  let differing = 0;
  let skipped = 0;
  let same = 0;
  let warnings = 0;
  let calls = 0;

  // The tool list and the server instructions travel the same way, so they are part of the parity.
  const [dl, hl] = await Promise.all([direct.listTools(), http.listTools()]);
  // Through JSON, as the stdio and HTTP transports carry it: the in-memory transport hands over
  // the objects themselves, with `title: undefined` keys that JSON drops.
  const listing = (l, c) => JSON.parse(JSON.stringify({
    tools: [...l.tools].sort((a, b) => a.name.localeCompare(b.name)),
    instructions: c.getInstructions(),
  }));
  const toolsDiff = diffAnswers(listing(dl, direct), listing(hl, http));
  console.log(`${toolsDiff.length ? 'DIFFERS' : 'same   '}  tools/list (${dl.tools.length} direct, ${hl.tools.length} http) + instructions${toolsDiff.length ? ': ' + toolsDiff.join(', ') : ''}`);
  if (toolsDiff.length) differing++; else same++;

  for (const [label, tool, toolArgs] of buildCases(args)) {
    if (!toolArgs) {
      skipped++;
      console.log(`skipped  ${label}: the copy has no data to call it with`);
      continue;
    }
    calls++;
    const d = normalise(await call(direct, tool, toolArgs), { dropDevWarning: false, warning: DEV_COPY_WARNING });
    const h = normalise(await call(http, tool, toolArgs), { dropDevWarning: true, warning: DEV_COPY_WARNING });
    warnings += h.dropped;
    const { real, excused, reasons } = judge(d.answer, h.answer);
    const state = d.answer.isError ? ' [tool answered an error on both sides]' : '';
    if (real.length) {
      differing++;
      console.log(`DIFFERS  ${label}: ${real.join(', ')}`);
    } else {
      same++;
      console.log(`same     ${label}${excused.length ? ` (excused: ${excused.join(', ')}; ${reasons.join('; ')})` : ''}${d.answer.isError && h.answer.isError ? state : ''}`);
    }
  }

  console.log(`dev-copy warning dropped from ${warnings} of ${calls} /mcp results`);
  if (!args.group) console.log('NOTE: the copy has no quiz group, so the quiz tools were compared on the empty list and the error answer only, not on real quiz data');
  console.log(`${same} same, ${differing} differing, ${skipped} skipped`);
  await Promise.allSettled([direct.close(), http.close()]);
  process.exit(differing ? 1 : 0);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error('parity: failed:', err);
    process.exit(2);
  });
}
