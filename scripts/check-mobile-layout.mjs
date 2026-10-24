#!/usr/bin/env node
// Checks the app shell at phone and desktop widths in a real browser, since
// jsdom has no layout and can't evaluate the media queries in app.css.
//
//   node scripts/check-mobile-layout.mjs [baseUrl] [screenshotDir]
//
// baseUrl defaults to the Vite dev server (http://127.0.0.1:5173). Read-only:
// it navigates and opens the menu, and never presses Sync or edits anything.
//
// Shell checks (fail → exit 1):
//   desktop  sidebar visible, no top bar, content clear of the sidebar
//   phone    sidebar hidden, menu opens it, a link closes it, Escape closes it
// Quick-lookup page checks (#134, fail → exit 1), at phone width:
//   Dashboard, Search, Directory, a course page and a student page don't
//   scroll sideways; Search/Directory tables fit their card; Search folds
//   email + grade under the name; the student header doesn't
//   overflow its card; "Add new note" opens a stacked form with fingertip-sized
//   buttons (then Cancel, nothing is saved). Directory results are a canned
//   reply (page.route), so no Schoology search runs. Desktop keeps its columns.
// Roster tab checks (#160, fail → exit 1): a course's Roster tab, with Private details on, in all
//   four modes (and Mastery's one-category layout) at 390px and 1100px: the page is never wider
//   than the window. Reads only, but not only Prism's database: the Test day step makes the page
//   read each unconfirmed learning plan's text from PowerSchool, through the dev server
//   (GET /api/students/:id/alert-detail/:key, one after another; the server keeps each answer
//   for 10 minutes, so the second width reads nothing new).
// Page report (informational, never fails): which pages still scroll
// sideways at phone width.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const base = (process.argv[2] || 'http://127.0.0.1:5173').replace(/\/$/, '');
const shotDir = process.argv[3] || '/tmp/prism-mobile';
mkdirSync(shotDir, { recursive: true });

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const STATIC_ROUTES = ['/', '/search', '/people', '/tools', '/import'];

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
};

const inViewport = (page, selector) => page.$eval(selector, (el) => {
  const r = el.getBoundingClientRect();
  const visible = getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  return visible && r.right > 0 && r.left < window.innerWidth;
});

const settle = (page) => page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

const browser = await chromium.launch();
try {
  // ---- Desktop: the shell must look exactly as before. ----
  const desktop = await browser.newPage({ viewport: DESKTOP });
  await desktop.goto(`${base}/`);
  await settle(desktop);
  check(await inViewport(desktop, '.sidebar'), 'desktop: sidebar visible');
  check(!(await inViewport(desktop, '.mobile-topbar')), 'desktop: no phone top bar');
  const contentLeft = await desktop.$eval('.content', (el) => el.getBoundingClientRect().left);
  check(contentLeft === 240, `desktop: content starts at 240px (got ${contentLeft})`);
  await desktop.screenshot({ path: join(shotDir, 'desktop-dashboard.png') });

  // ---- Phone: drawer behaviour. ----
  const phone = await browser.newPage({ viewport: PHONE, isMobile: true, hasTouch: true });
  await phone.goto(`${base}/`);
  await settle(phone);
  check(!(await inViewport(phone, '.sidebar')), 'phone: sidebar hidden at rest');
  check(await inViewport(phone, '.menu-btn'), 'phone: menu button visible');
  const phoneLeft = await phone.$eval('.content', (el) => el.getBoundingClientRect().left);
  check(phoneLeft === 0, `phone: content uses the full width (left ${phoneLeft})`);
  await phone.screenshot({ path: join(shotDir, 'phone-dashboard.png') });

  await phone.tap('.menu-btn');
  await phone.waitForTimeout(300); // slide-in transition
  check(await inViewport(phone, '.sidebar'), 'phone: menu opens the sidebar');
  await phone.screenshot({ path: join(shotDir, 'phone-menu-open.png') });

  await phone.tap('.sidebar a[href="/people"]');
  await phone.waitForTimeout(300);
  check(phone.url().endsWith('/people'), 'phone: menu link navigates');
  check(!(await inViewport(phone, '.sidebar')), 'phone: following a link closes the menu');

  await phone.tap('.menu-btn');
  await phone.waitForTimeout(300);
  await phone.keyboard.press('Escape');
  await phone.waitForTimeout(300);
  check(!(await inViewport(phone, '.sidebar')), 'phone: Escape closes the menu');

  // ---- Phone: page-by-page sideways-scroll report. ----
  const routes = [...STATIC_ROUTES];
  await phone.goto(`${base}/`);
  await settle(phone);
  const firstHref = (sel) => phone.$eval(sel, (a) => a.getAttribute('href')).catch(() => null);
  const course = await firstHref('.content a[href^="/course/"]');
  if (course) {
    routes.push(course);
    await phone.goto(`${base}${course}`);
    await settle(phone);
    const student = await firstHref('.content a[href^="/student/"]');
    if (student) routes.push(student);
  }

  // ---- Phone: quick-lookup pages (#134). ----
  const fitsSideways = () => phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const visible = (sel) => phone.$eval(sel, (el) => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0).catch(() => false);
  const tableFits = (sel) => phone.$eval(sel, (t) => t.scrollWidth <= t.clientWidth + 1 && t.getBoundingClientRect().right <= window.innerWidth).catch(() => false);
  const box = (sel) => phone.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; }).catch(() => null);

  console.log('\nQuick-lookup pages at 390px:');
  await phone.goto(`${base}/`);
  await settle(phone);
  check(await fitsSideways(), 'phone /: no sideways scroll');

  await phone.goto(`${base}/search`);
  await settle(phone);
  check(await fitsSideways(), 'phone /search: no sideways scroll');
  if (await phone.$('.content table')) {
    check(await tableFits('.content table'), 'phone /search: the table fits its card');
    check(!(await visible('.content th.col-desktop')), 'phone /search: email + grade columns fold away');
    check(await visible('.content .person-sub'), 'phone /search: email + grade show under the name');
  }

  await phone.route('**/api/people/search**', (r) => r.fulfill({ json: {
    query: 'test', complete: true,
    results: [{ userId: 1, name: 'Alexandra Testperson-Longname', school: 'Hong Kong International School - High School', messageUserId: 1 }],
  } }));
  await phone.goto(`${base}/people`);
  await settle(phone);
  if (await phone.$('.content input[type="search"]')) {
    await phone.fill('.content input[type="search"]', 'test');
    await phone.tap('.content button[type="submit"]');
    await phone.waitForSelector('.content table', { timeout: 5000 }).catch(() => {});
    check(await tableFits('.content table'), 'phone /people: the results table fits its card');
  }
  check(await fitsSideways(), 'phone /people: no sideways scroll');
  await phone.unroute('**/api/people/search**');

  if (course) {
    await phone.goto(`${base}${course}`);
    await settle(phone);
    check(await fitsSideways(), `phone ${course}: no sideways scroll`);
  }

  // ---- The Roster tab (#160): all four modes, Private details on, at phone and a narrow desktop. ----
  // The cards answer the roster's own width (@container roster), so a page that scrolls sideways at
  // either width is a failed rule. A fresh context per width, with the switch set before the page loads.
  if (course) {
    console.log('\nRoster tab, Private details on:');
    for (const [label, viewport, mobile] of [['390px', PHONE, true], ['1100px', { width: 1100, height: 900 }, false]]) {
      const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
      await ctx.addInitScript(() => { try { localStorage.setItem('prism:private-details', 'true'); } catch { /* ignore */ } });
      const page = await ctx.newPage();
      for (const mode of ['roster', 'attention', 'testday', 'mastery']) {
        await page.goto(`${base}${course}?tab=roster&mode=${mode}`);
        await settle(page);
        const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth, tab: !!document.querySelector('.roster-tab') }));
        check(m.tab, `${label} roster ${mode}: the Roster tab is drawn`);
        check(m.scroll === m.inner, `${label} roster ${mode}: no sideways page scroll (${m.scroll} of ${m.inner}px)`);
      }
      // Mastery's one-category layout (a sticky header and the topic columns) is the widest thing on the tab.
      const cat = await page.$('.mastery-cats button:nth-of-type(2)');
      if (cat) {
        await cat.click();
        await page.waitForTimeout(300);
        const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth, rows: document.querySelectorAll('.mastery-row').length }));
        check(w.rows > 0, `${label} roster mastery, one category: rows are drawn`);
        check(w.scroll === w.inner, `${label} roster mastery, one category: no sideways page scroll (${w.scroll} of ${w.inner}px)`);
      } else {
        console.log(`SKIP  ${label} roster mastery: one-category Mastery (course has one category)`);
      }
      await ctx.close();
    }
  }

  const student = routes.find((r) => r.startsWith('/student/'));
  if (student) {
    await phone.goto(`${base}${student}`);
    await settle(phone);
    check(await fitsSideways(), `phone ${student}: no sideways scroll`);
    check(await phone.$eval('.student-header', (c) => c.scrollWidth <= c.clientWidth + 1).catch(() => false),
      `phone ${student}: profile + family contacts fit their card`);
    const add = await box('button[aria-label="Add new note"]');
    check(!!add && add.w >= 44 && add.h >= 44, `phone ${student}: "Add new note" is a 44px target`);
    await phone.tap('button[aria-label="Add new note"]');
    const area = await box('.note-form textarea');
    const card = await box('.note-form');
    check(!!area && !!card && area.w >= card.w - 1, `phone ${student}: the note box takes the full width`);
    const save = await phone.$eval('.note-form button.primary', (b) => b.getBoundingClientRect().height).catch(() => 0);
    check(save >= 44, `phone ${student}: Save is a 44px target`);
    await phone.screenshot({ path: join(shotDir, 'phone-student-add-note.png') });
    await phone.tap('.note-form button.ghost'); // Cancel: nothing is saved
  }

  // Desktop keeps the columns a phone folds away.
  await desktop.goto(`${base}/search`);
  await settle(desktop);
  if (await desktop.$('.content th.col-desktop')) {
    check(await desktop.$eval('.content th.col-desktop', (el) => getComputedStyle(el).display !== 'none'), 'desktop /search: email + grade columns shown');
    check(!(await desktop.$eval('.content .person-sub', (el) => getComputedStyle(el).display !== 'none').catch(() => false)), 'desktop /search: no folded line under the name');
  }

  console.log('\nPage report at 390px (informational):');
  for (const route of routes) {
    await phone.goto(`${base}${route}`);
    await settle(phone);
    const { scrollW, innerW } = await phone.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
    }));
    const note = scrollW > innerW ? `scrolls sideways (${scrollW}px wide)` : 'fits';
    console.log(`  ${route.padEnd(24)} ${note}`);
    const name = route === '/' ? 'root' : route.replace(/^\//, '').replace(/\//g, '-');
    await phone.screenshot({ path: join(shotDir, `phone-${name}.png`), fullPage: true });
  }
} finally {
  await browser.close();
}

console.log(`\nScreenshots: ${shotDir}`);
if (failures.length) {
  console.log(`${failures.length} shell check(s) failed.`);
  process.exit(1);
}
