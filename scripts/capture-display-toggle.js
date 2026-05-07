/**
 * Capture network traffic when toggling "Display to student" in Schoology's
 * mastery gradebook. Goal: identify the payload field on the iapi2
 * observations endpoint (or a sibling endpoint) that controls per-student
 * mastery visibility — needed for issue #34.
 *
 * Logs every request whose URL or body looks publish/visibility-related,
 * captures the full POST body (writeMasteryScores' payload doesn't currently
 * carry this field, so the diff against a captured "toggle ON" / "toggle OFF"
 * pair will reveal it), and writes everything to
 * scripts/display-toggle-capture.json on browser close.
 *
 * Usage:
 *   node scripts/capture-display-toggle.js [sectionId] [assignmentId]
 *
 * Defaults to AIML section. The script auto-navigates to the mastery
 * gradebook for that section. From there:
 *   1. Drill into a student / assignment with a mastery score
 *   2. Toggle "Display to student" OFF, wait a beat
 *   3. Toggle it back ON, wait a beat
 *   4. Close the browser
 *
 * The script prints a flagged list of any request whose body or URL contains
 * publish/display/visibility/show keywords — that's where the field lives.
 */

import { chromium } from 'playwright';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';

const SCHOOLOGY_BASE = 'https://schoology.hkis.edu.hk';
const STATE_FILE = join(process.cwd(), '.playwright-session', 'storage-state.json');
const OUT_FILE = join(process.cwd(), 'scripts', 'display-toggle-capture.json');

const DEFAULT_SECTION = '7899907727'; // AIML
const sectionId = process.argv[2] || DEFAULT_SECTION;
const assignmentId = process.argv[3] || null;

// Match anything that looks like Schoology's mastery / grade / publish APIs.
// Includes /iapi/ (without the 2) — the gradebook comment popup hits
// /iapi/grades/... rather than /iapi2/district-mastery/...
const MATCH = (url) =>
  url.includes('/district_mastery') ||
  url.includes('/district-mastery') ||
  url.includes('/iapi/') ||
  url.includes('/iapi2/') ||
  url.includes('/grade') ||
  url.includes('/publish') ||
  url.includes('/observation') ||
  url.includes('/comment');

// Keywords that hint at the visibility field. Bodies/URLs containing any of
// these get flagged in the post-capture summary.
const FLAG_KEYWORDS = [
  'publish', 'display', 'show_to_student', 'show-to-student',
  'visible', 'visibility', 'hidden', 'comment_status',
  'is_published', 'isPublished', 'show', 'student_view',
];

function shortBody(text, max = 8000) {
  if (!text) return null;
  return text.length > max ? text.slice(0, max) + `…[truncated ${text.length - max} chars]` : text;
}

function bodyHasKeyword(body) {
  if (!body) return null;
  const lower = body.toLowerCase();
  return FLAG_KEYWORDS.find(k => lower.includes(k.toLowerCase())) || null;
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

  // We listen at the REQUEST level (not response) so we catch sendBeacon /
  // keepalive fetches that may not produce a normal response event.
  // Everything non-GET on the schoology.hkis.edu.hk origin is captured
  // unconditionally — we'd rather have noise than miss the save call.
  const STATIC_ASSET = (url) => /\.(?:js|css|png|jpe?g|gif|svg|ico|woff2?|ttf|map)(?:\?|$)/i.test(url);
  const SCHOOLOGY_ORIGIN = (url) => url.startsWith(SCHOOLOGY_BASE) || url.includes('schoology.com');

  page.on('websocket', (ws) => {
    const url = ws.url();
    console.log(`[WS open] ${url}`);
    captured.push({ kind: 'ws-open', url, t: new Date().toISOString() });
    ws.on('framesent', (frame) => {
      const payload = typeof frame.payload === 'string' ? frame.payload : '[binary]';
      console.log(`[WS →] ${url} ${payload.slice(0, 200)}`);
      captured.push({ kind: 'ws-send', url, payload: shortBody(payload), t: new Date().toISOString() });
    });
    ws.on('framereceived', (frame) => {
      const payload = typeof frame.payload === 'string' ? frame.payload : '[binary]';
      // Only log received frames that look interesting — these can be very chatty
      if (FLAG_KEYWORDS.some(k => payload.toLowerCase().includes(k.toLowerCase()))) {
        console.log(`[WS ←] ${url} ${payload.slice(0, 200)}  ⚑`);
        captured.push({ kind: 'ws-recv', url, payload: shortBody(payload), t: new Date().toISOString() });
      }
    });
  });

  page.on('request', (req) => {
    const url = req.url();
    const method = req.method();
    if (STATIC_ASSET(url)) return;
    // Always log non-GET on Schoology origin — that's where the save will live.
    // For GETs, only log MATCH() hits to keep volume manageable.
    if (method === 'GET' && !MATCH(url)) return;
    if (method !== 'GET' && !SCHOOLOGY_ORIGIN(url)) return;

    const postData = req.postData() || null;
    const flagInPost = bodyHasKeyword(postData);
    const entry = {
      kind: 'request',
      method,
      url,
      postData,
      flagInPost,
      t: new Date().toISOString(),
    };
    captured.push(entry);
    const flagTag = flagInPost ? `  ⚑ ${flagInPost}` : '';
    console.log(`[req ${method}] ${url}${flagTag}`);
    if (postData && method !== 'GET') {
      console.log(`     body: ${postData.slice(0, 500)}`);
    }
  });

  page.on('response', async (res) => {
    const req = res.request();
    const url = req.url();
    const method = req.method();
    if (STATIC_ASSET(url)) return;
    if (method === 'GET' && !MATCH(url)) return;
    if (method !== 'GET' && !SCHOOLOGY_ORIGIN(url)) return;

    let body = null;
    try {
      const ct = res.headers()['content-type'] || '';
      if (ct.includes('json') || ct.includes('text') || ct.includes('xml')) {
        body = await res.text();
      } else {
        body = `[${ct}]`;
      }
    } catch (e) {
      body = `[body read failed: ${e.message}]`;
    }

    const postData = req.postData() || null;
    const flagInPost = bodyHasKeyword(postData);
    const flagInResp = bodyHasKeyword(body);

    const entry = {
      method: req.method(),
      url,
      status: res.status(),
      contentType: res.headers()['content-type'] || null,
      postData,
      body: shortBody(body),
      flagInPost,
      flagInResp,
      t: new Date().toISOString(),
    };
    captured.push(entry);

    const flagTag = (flagInPost || flagInResp) ? `  ⚑ ${flagInPost || flagInResp}` : '';
    console.log(`[${res.status()}] ${req.method()} ${url}${flagTag}`);
  });

  const startUrl = `${SCHOOLOGY_BASE}/course/${sectionId}/grades`;
  console.log(`Navigating to ${startUrl}`);
  if (assignmentId) console.log(`Target assignment: ${assignmentId}`);
  console.log('\nINSTRUCTIONS:');
  console.log('  1. In the gradebook, click into a cell that has a comment (or open the');
  console.log('     comment popup for one with a score) so the comment-entry dialog opens.');
  console.log('  2. Toggle "Display to student" OFF inside the popup — save / commit so the');
  console.log('     request fires. Wait for the spinner to settle.');
  console.log('  3. Reopen the popup, toggle it back ON, save again.');
  console.log('  4. Close the browser window to save the capture.\n');

  await page.goto(startUrl, { waitUntil: 'load' });

  await new Promise((resolve) => {
    browser.on('disconnected', resolve);
  });

  writeFileSync(OUT_FILE, JSON.stringify(captured, null, 2));
  console.log(`\nCaptured ${captured.length} requests → ${OUT_FILE}`);

  // Surface the flagged ones — these are the prime suspects.
  const flagged = captured.filter(e => e.flagInPost || e.flagInResp);
  if (flagged.length) {
    console.log(`\nFlagged (${flagged.length}) — request body or response contains a visibility keyword:`);
    for (const e of flagged) {
      const where = e.flagInPost ? `post:${e.flagInPost}` : `resp:${e.flagInResp}`;
      console.log(`  [${where}] ${e.method} ${e.url}`);
    }
  } else {
    console.log('\nNo flagged requests — the field name may not match our keyword list.');
    console.log('Check the JSON manually for any POST that fired between the toggle clicks.');
  }

  // Compact pattern view — handy for spotting a new endpoint we haven't seen.
  const patterns = new Map();
  for (const e of captured) {
    const pat = `${e.method} ${e.url.replace(/\d{4,}/g, '{id}').split('?')[0]}`;
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
