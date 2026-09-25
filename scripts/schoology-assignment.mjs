// Create, update or read a Schoology assignment through the public REST API (no browser).
// Proven 25 Sep 2026 (see .claude/schoology-api-reference.md, "Writing assignments"):
//   create (POST) and update (PUT) work; PUT is a PARTIAL update (omitted fields are kept);
//   descriptions keep HTML and inline styles; read them back with ?richtext=1.
//   NOT possible through this API: folder placement, individual assignees, test/quiz (assessment)
//   items, learning-objective alignment, rubrics. Those still need the Schoology web UI.
//
// Usage (from ~/repos/prism, credentials by reference only):
//   node --env-file=.env scripts/schoology-assignment.mjs get    --section S --id A
//   node --env-file=.env scripts/schoology-assignment.mjs create --section S --title T [options]
//   node --env-file=.env scripts/schoology-assignment.mjs update --section S --id A [options]
// Options:
//   --html FILE            description from an HTML file (inline styles only; no <style> blocks)
//   --due "YYYY-MM-DD HH:MM"   due date and time (school local time)
//   --category summative|formative   "Evidence of Learning - Summative/Formative"
//   --scale NAME           gradebook scale by exact title, e.g. "General Academic Scale"
//   --publish 0|1          create defaults to 0 (unpublished)
//   --dry-run              print what would be sent, change nothing
// Every update saves the assignment's previous state to ./schoology-backups/ first.
import fs from 'fs';
import path from 'path';
import { apiGet, apiPut, apiPost } from '../server/services/schoology.js';

const [cmd, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--dry-run') opt.dryRun = true;
  else if (rest[i].startsWith('--')) opt[rest[i].slice(2)] = rest[++i];
}
const die = (m) => { console.error('ERROR: ' + m); process.exit(1); };
if (!opt.section) die('--section is required');

const TITLE_RULE = /^[A-Z][A-Za-z&+ ]*: .+ \((S|F)\)( .*)?$/;   // "AP CSP: CPT 2 - NFT Marketplace (S)"

async function resolveCategory(section, kind) {
  const want = { summative: 'Evidence of Learning - Summative', formative: 'Evidence of Learning - Formative' }[kind];
  if (!want) die('--category must be summative or formative');
  const cats = (await apiGet(`/sections/${section}/grading_categories`)).grading_category || [];
  const hit = cats.find(c => c.title === want);
  if (!hit) die(`category "${want}" not found in section ${section}`);
  return hit.id;
}
async function resolveScale(section, name) {
  if (/letter grade/i.test(name)) die('never use "HS Letter Grade" (Graham\'s rule)');
  const scales = (await apiGet(`/sections/${section}/grading_scales`)).grading_scale || [];
  const hit = scales.find(s => s.title === name);
  if (!hit) die(`scale "${name}" not found. Available: ${scales.map(s => s.title).join(', ')}`);
  return hit.id;
}

async function buildBody() {
  const body = {};
  if (opt.title) {
    if (!TITLE_RULE.test(opt.title)) die('title must follow "<Course>: <name> (S)" or "(F)"');
    body.title = opt.title;
  }
  if (opt.html) {
    const html = fs.readFileSync(opt.html, 'utf8');
    if (/<style[\s>]/i.test(html)) die('HTML contains a <style> block; Schoology strips it. Use inline styles.');
    body.description = html;
  }
  if (opt.due) body.due = /:\d\d:\d\d$/.test(opt.due) ? opt.due : `${opt.due}:00`;
  if (opt.category) body.grading_category = await resolveCategory(opt.section, opt.category);
  if (opt.scale) body.grading_scale = await resolveScale(opt.section, opt.scale);
  if (opt.publish !== undefined) body.published = Number(opt.publish);
  return body;
}

function summary(a) {
  return { id: a.id, title: a.title, due: a.due, grading_category: a.grading_category, grading_scale: a.grading_scale,
    max_points: a.max_points, published: a.published, folder_id: a.folder_id, type: a.type,
    description_chars: (a.description || '').length };
}

if (cmd === 'get') {
  if (!opt.id) die('--id is required');
  const a = await apiGet(`/sections/${opt.section}/assignments/${opt.id}?richtext=1`);
  console.log(JSON.stringify(summary(a), null, 2));
  if (opt.out) { fs.writeFileSync(opt.out, a.description || ''); console.log('description written to', opt.out); }
} else if (cmd === 'create') {
  if (!opt.title) die('--title is required');
  const body = await buildBody();
  body.max_points = 100;                        // every task is out of 100
  if (body.published === undefined) body.published = 0;
  if (opt.dryRun) { console.log('DRY RUN create', JSON.stringify({ ...body, description: body.description ? `[${body.description.length} chars]` : undefined })); process.exit(0); }
  const r = await apiPost(`/sections/${opt.section}/assignments`, body);
  if (r.status !== 201) die(`create failed ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  console.log('created', JSON.stringify(summary(r.data)));
  console.log('Still to do in the Schoology web UI: move it to its folder, align learning objectives (summatives), attach the rubric.');
} else if (cmd === 'update') {
  if (!opt.id) die('--id is required');
  const body = await buildBody();
  if (!Object.keys(body).length) die('nothing to update');
  const before = await apiGet(`/sections/${opt.section}/assignments/${opt.id}?richtext=1`);
  if (opt.dryRun) { console.log('DRY RUN update', opt.id, JSON.stringify(Object.keys(body)), 'current:', JSON.stringify(summary(before))); process.exit(0); }
  fs.mkdirSync('schoology-backups', { recursive: true });
  const bak = path.join('schoology-backups', `${opt.section}-${opt.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(bak, JSON.stringify(before));
  const r = await apiPut(`/sections/${opt.section}/assignments/${opt.id}`, body);
  if (r.status !== 204 && r.status !== 200) die(`update failed ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  const after = await apiGet(`/sections/${opt.section}/assignments/${opt.id}`);
  console.log('updated', JSON.stringify(summary(after)), '| backup:', bak);
} else {
  die('command must be get, create or update');
}
