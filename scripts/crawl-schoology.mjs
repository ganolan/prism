#!/usr/bin/env node
// Fixed-capability, READ-ONLY endpoint-discovery crawler.
//
// Drives the Schoology UI (and any systems it embeds, e.g. PowerSchool) with the
// saved Playwright session, captures every network request, and reports a
// deduped endpoint inventory + embedded-frame hosts + JS endpoint candidates.
// This is the bulk discovery tool for the API-exploration playbook
// (.claude/api-exploration-playbook.md).
//
// SAFETY: navigation/GET only. It never submits forms, never POSTs, and never
// follows logout/delete/destructive links. Arguments are parameters only — no
// code is eval'd, so this stays a fixed-capability helper.
//
// Usage:
//   node scripts/crawl-schoology.mjs \
//     [--seeds /home,/courses,/grades] [--max-pages 40] [--max-depth 2] \
//     [--base https://schoology.hkis.edu.hk] [--grep-js] [--out scripts/crawl-capture.json]
//
// Requires a fresh session: run `npm run mastery:login` first.

import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';

// ---- arg parsing (params only, never code) ----
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def; };
const flag = (name) => argv.includes('--' + name);
const BASE = arg('base', 'https://schoology.hkis.edu.hk').replace(/\/$/, '');
const SEEDS = arg('seeds', '/home,/courses,/grades,/messages,/calendar').split(',').map(s => s.trim()).filter(Boolean);
const MAX_PAGES = parseInt(arg('max-pages', '40'), 10);
const MAX_DEPTH = parseInt(arg('max-depth', '2'), 10);
const GREP_JS = flag('grep-js');
const OUT = arg('out', 'scripts/crawl-capture.json'); // *-capture.json is gitignored
const STATE = join(process.cwd(), '.playwright-session', 'storage-state.json');

// ---- helpers ----
const SKIP_LINK = /logout|sign[_-]?out|signout|\/delete|destroy|remove|\/print|\/export|mailto:|tel:|javascript:|^#|\.csv|\.pdf|\.zip|\bunenroll\b/i;
const normPath = (u) => {
  try {
    const url = new URL(u);
    let p = url.pathname
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '{uuid}')
      .replace(/\b\d{3,}\b/g, '{id}');
    return url.host + p;
  } catch { return u.slice(0, 80); }
};
const isLoginBounce = (u) => /login\.microsoftonline\.com|\/login|\/saml|accounts\.google\.com|signin|adfs/i.test(u);

// ---- state ----
const endpoints = new Map();   // host+method+pathTemplate -> {host, method, pathTemplate, statuses:Set, cts:Set, types:Set, count, example}
const frames = new Map();      // embedded-frame host -> {host, count, examples:Set}
const jsUrls = new Set();
const bounces = new Set();
const visited = new Set();
const pagesVisited = [];

function recordResponse(res) {
  try {
    const req = res.request();
    const u = res.url();
    if (isLoginBounce(u)) bounces.add(u.split('?')[0]);
    if (/\.js(\?|$)/.test(u)) jsUrls.add(u.split('?')[0]);
    const host = new URL(u).host;
    const key = host + ' ' + req.method() + ' ' + normPath(u);
    let e = endpoints.get(key);
    if (!e) { e = { host, method: req.method(), pathTemplate: normPath(u).replace(host, ''), statuses: new Set(), cts: new Set(), types: new Set(), count: 0, example: u.split('?')[0] }; endpoints.set(key, e); }
    e.statuses.add(res.status());
    e.cts.add((res.headers()['content-type'] || '').split(';')[0]);
    e.types.add(req.resourceType());
    e.count++;
  } catch {}
}

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext(existsSync(STATE) ? { storageState: STATE } : {});
context.on('response', recordResponse);
context.on('frameattached', () => {});
const page = await context.newPage();

const queue = SEEDS.map(s => ({ url: s.startsWith('http') ? s : BASE + s, depth: 0 }));
let sessionDead = false;

while (queue.length && pagesVisited.length < MAX_PAGES && !sessionDead) {
  const { url, depth } = queue.shift();
  const norm = normPath(url);
  if (visited.has(norm)) continue;
  visited.add(norm);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500); // let deferred XHRs fire
  } catch (e) { pagesVisited.push({ url, depth, error: String(e).slice(0, 80) }); continue; }

  const landed = page.url();
  if (isLoginBounce(landed)) { bounces.add(landed.split('?')[0]); sessionDead = true; pagesVisited.push({ url, depth, bouncedToLogin: true }); break; }
  pagesVisited.push({ url, depth, landed: landed.split('?')[0] });

  // record embedded (cross-origin) frame hosts
  for (const f of page.frames()) {
    try { const h = new URL(f.url()).host; if (h && h !== new URL(BASE).host) { const r = frames.get(h) || { host: h, count: 0, examples: new Set() }; r.count++; if (r.examples.size < 3) r.examples.add(f.url().split('?')[0]); frames.set(h, r); } } catch {}
  }

  // enqueue same-base, non-destructive links
  if (depth < MAX_DEPTH) {
    let hrefs = [];
    try { hrefs = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => a.href)); } catch {}
    for (const h of hrefs) {
      if (!h.startsWith(BASE)) continue;
      if (SKIP_LINK.test(h)) continue;
      const n = normPath(h);
      if (!visited.has(n) && !queue.find(q => normPath(q.url) === n)) queue.push({ url: h.split('#')[0], depth: depth + 1 });
    }
  }
}

// optional: grep loaded JS for endpoint string literals
const jsCandidates = new Set();
if (GREP_JS && !sessionDead) {
  for (const ju of [...jsUrls].slice(0, 25)) {
    try {
      const t = await page.evaluate(async (u) => { try { return await (await fetch(u, { credentials: 'include' })).text(); } catch { return ''; } }, ju);
      for (const re of [/["'`](\/(?:teachers|ws|iapi2?|course|apps|v1)\/[A-Za-z0-9_./{}-]{2,80})["'`]/g, /["'`]([A-Za-z0-9_./-]*\.(?:json|html))["'`]/g, /["'`]([A-Za-z0-9_]+\/queries\/[A-Za-z0-9_.]+)["'`]/g]) {
        let m; while ((m = re.exec(t))) if (m[1].length < 90) jsCandidates.add(m[1]);
      }
    } catch {}
  }
}

await browser.close();

// ---- serialize ----
const out = {
  generatedBy: 'scripts/crawl-schoology.mjs',
  base: BASE,
  seeds: SEEDS,
  config: { maxPages: MAX_PAGES, maxDepth: MAX_DEPTH, grepJs: GREP_JS },
  sessionExpired: sessionDead,
  pagesVisited,
  loginBounces: [...bounces],
  embeddedFrameHosts: [...frames.values()].map(f => ({ ...f, examples: [...f.examples] })),
  endpoints: [...endpoints.values()]
    .map(e => ({ host: e.host, method: e.method, pathTemplate: e.pathTemplate, statuses: [...e.statuses], contentTypes: [...e.cts], resourceTypes: [...e.types], hits: e.count, example: e.example }))
    .sort((a, b) => a.host.localeCompare(b.host) || a.pathTemplate.localeCompare(b.pathTemplate)),
  jsEndpointCandidates: [...jsCandidates].sort(),
};
writeFileSync(OUT, JSON.stringify(out, null, 2));

// ---- console summary ----
const byHost = {};
for (const e of out.endpoints) (byHost[e.host] ||= 0), byHost[e.host]++;
console.log(`\nCrawl complete. pages=${pagesVisited.length} endpoints=${out.endpoints.length} embeddedHosts=${out.embeddedFrameHosts.length} jsCandidates=${out.jsEndpointCandidates.length}`);
if (sessionDead) console.log('⚠️  SESSION EXPIRED mid-crawl (login bounce). Re-run `npm run mastery:login` and retry.');
console.log('\nendpoints by host:');
for (const [h, n] of Object.entries(byHost).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${h}`);
if (out.embeddedFrameHosts.length) { console.log('\nembedded (cross-origin) frame hosts — possible other systems:'); for (const f of out.embeddedFrameHosts) console.log(`  ${f.host}  (${f.examples[0] || ''})`); }
console.log(`\nfull report: ${OUT}`);
