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
// Page report (informational, never fails): which pages still scroll sideways
// at phone width — that is page-level work, not the shell's.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const base = (process.argv[2] || 'http://127.0.0.1:5173').replace(/\/$/, '');
const shotDir = process.argv[3] || '/tmp/prism-mobile';
mkdirSync(shotDir, { recursive: true });

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const STATIC_ROUTES = ['/', '/search', '/people', '/feedback', '/tools', '/import'];

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
