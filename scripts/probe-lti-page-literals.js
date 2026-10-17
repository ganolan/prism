// Spike (#142), read only: fetch an lti_submission assignment's page over plain
// HTTP (saved session cookies), list the app-related React props, then fetch
// the page's own script bundles (public CDN) and grep them for route literals.
// Saves bundles under OUT for further grepping; prints masked snippets only.
//
// Usage: node scripts/probe-lti-page-literals.js <assignmentId> [grepRegex]
//   OUT defaults to /tmp/probe-lti-page-literals.
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { cookieJar, getPage } from '../server/services/schoologyWeb.js';

const aid = process.argv[2];
const grep = new RegExp(process.argv[3] || 'iapi2\\/assignments\\/[^"\'`]{0,80}|lti-submission[^"\'`]{0,80}|context=assignment_[a-z_]+', 'g');
const OUT = process.env.OUT || '/tmp/probe-lti-page-literals';
mkdirSync(OUT, { recursive: true });
const jar = cookieJar();
const { html } = await getPage(jar, `/assignment/${aid}`);
writeFileSync(join(OUT, `assignment-${aid}.html`), html);
const unesc = html.replace(/\\\//g, '/');
const mask = (s) => s.replace(/[A-Za-z0-9_-]{25,}/g, (m) => `<${m.length}ch>`).replace(/\b\d{6,}\b/g, (m) => `<${m.length}d>`);

for (const key of ['launchUrl', 'submissionsTargetUrl', 'submissionProps', 'cookiePreloadUrl', 'documentUrl', 'gradingUrl', 'ltiGrading']) {
  for (const m of unesc.matchAll(new RegExp(`"${key}":`, 'g'))) {
    console.log(`prop ${key}: ${mask(unesc.slice(m.index, m.index + 400))}`);
  }
}

const scripts = [...new Set([...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]))]
  .filter((u) => /assignment|lti|submission|grader|vendor|main|app/i.test(u));
console.log(`\nscripts: ${scripts.length}`);
const seen = new Map();
for (const src of scripts) {
  const url = src.startsWith('http') ? src : src.startsWith('//') ? `https:${src}` : `https://schoology.hkis.edu.hk${src}`;
  const res = await fetch(url).catch(() => null);
  if (!res || res.status !== 200) { console.log(`  ${res?.status} ${url.slice(0, 120)}`); continue; }
  const js = await res.text();
  writeFileSync(join(OUT, url.split('/').pop().split('?')[0] || 'bundle.js'), js);
  for (const m of js.matchAll(grep)) seen.set(m[0], url.split('/').pop().split('?')[0]);
  await new Promise((r) => setTimeout(r, 300));
}
console.log(`\nliterals (${seen.size}):`);
for (const [lit, file] of seen) console.log(`  ${mask(lit)}   [${file.slice(0, 50)}]`);
