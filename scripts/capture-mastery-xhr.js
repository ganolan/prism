/**
 * Mastery XHR Capture
 *
 * Opens Schoology's mastery gradebook in a visible browser using the saved
 * Playwright session, logs every district_mastery / iapi2 district-mastery
 * request + response, and writes them to scripts/mastery-xhr-capture.json
 * when the browser is closed.
 *
 * Goal: find the endpoint that returns Schoology's per-reporting-category
 * rolled-up mastery level (the one shown in the mastery gradebook UI).
 *
 * Usage:
 *   node scripts/capture-mastery-xhr.js [sectionId]
 *
 * If sectionId is omitted, defaults to AIML (7899907727). Click around the
 * mastery gradebook — drill into a student, a reporting category, an
 * assignment — then close the browser. Any captured requests whose URL
 * contains "category", "rollup", "summary", "report" are flagged at the end.
 */

import { chromium } from 'playwright';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';

const SCHOOLOGY_BASE = 'https://schoology.hkis.edu.hk';
const STATE_FILE = join(process.cwd(), '.playwright-session', 'storage-state.json');
const OUT_FILE = join(process.cwd(), 'scripts', 'mastery-xhr-capture.json');

const DEFAULT_SECTION = '7899907727'; // AIML
const sectionId = process.argv[2] || DEFAULT_SECTION;

const MATCH = (url) =>
  url.includes('/district_mastery') ||
  url.includes('/district-mastery') ||
  url.includes('/iapi2/');

const FLAG_KEYWORDS = ['category', 'rollup', 'summary', 'report', 'grade'];

function shortBody(text, max = 4000) {
  if (!text) return null;
  return text.length > max ? text.slice(0, max) + `…[truncated ${text.length - max} chars]` : text;
}

async function main() {
  if (!existsSync(STATE_FILE)) {
    console.error(`No saved session at ${STATE_FILE}. Run: npm run mastery:login`);
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ storageState: STATE_FILE });
  const page = await context.newPage();

  const captured = [];
  const seen = new Set();

  page.on('response', async (res) => {
    const req = res.request();
    const url = req.url();
    if (!MATCH(url)) return;

    const key = `${req.method()} ${url}`;
    // Keep duplicates but cap verbosity
    let body = null;
    try {
      const ct = res.headers()['content-type'] || '';
      if (ct.includes('json') || ct.includes('text')) {
        body = await res.text();
      } else {
        body = `[${ct}]`;
      }
    } catch (e) {
      body = `[body read failed: ${e.message}]`;
    }

    const entry = {
      method: req.method(),
      url,
      status: res.status(),
      contentType: res.headers()['content-type'] || null,
      postData: req.postData() || null,
      body: shortBody(body),
      t: new Date().toISOString(),
    };
    captured.push(entry);

    const tag = seen.has(key) ? '  (repeat)' : '';
    seen.add(key);
    console.log(`[${res.status()}] ${req.method()} ${url}${tag}`);
  });

  const startUrl = `${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery`;
  console.log(`Navigating to ${startUrl}`);
  console.log('CLICK AROUND: drill into students, reporting categories, individual assignments.');
  console.log('Close the browser window when done to save the capture.\n');

  await page.goto(startUrl, { waitUntil: 'load' });

  // Keep alive until the user closes the browser
  await new Promise((resolve) => {
    browser.on('disconnected', resolve);
  });

  writeFileSync(OUT_FILE, JSON.stringify(captured, null, 2));
  console.log(`\nCaptured ${captured.length} requests → ${OUT_FILE}`);

  // Highlight anything that looks like a category rollup
  const flagged = captured.filter(e =>
    FLAG_KEYWORDS.some(k => e.url.toLowerCase().includes(k))
  );
  if (flagged.length) {
    console.log(`\nPotentially relevant (${flagged.length}):`);
    for (const e of flagged) {
      console.log(`  ${e.method} ${e.url}`);
    }
  }

  // Unique URL patterns
  const patterns = new Map();
  for (const e of captured) {
    // Collapse numeric IDs for pattern view
    const pat = e.url.replace(/\d{4,}/g, '{id}').split('?')[0];
    patterns.set(pat, (patterns.get(pat) || 0) + 1);
  }
  console.log('\nUnique endpoint patterns:');
  for (const [pat, count] of [...patterns.entries()].sort()) {
    console.log(`  (${count}x) ${pat}`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
