// Visual check (triage resubmissions, task 11). Screenshots the Dashboard rail
// and one assessment page (via a Dashboard row's deep link) at phone + desktop
// widths against a running dev server. Read-only: no writes, no navigation that
// mutates data. Run from the repo root (not /tmp) so Playwright resolves.
// Usage: BASE_URL=http://127.0.0.1:5173 node scripts/screenshot-triage-resubmissions.mjs
import { chromium } from 'playwright';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5173';
const SIZES = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 900 },
];

async function main() {
  const browser = await chromium.launch();
  for (const size of SIZES) {
    const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });

    // 1. Dashboard rail — scroll to the Resubmissions panel if present.
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800); // let triage data settle in
    const panel = page.locator('section[aria-label="Resubmissions"]');
    const panelCount = await panel.count();
    if (panelCount > 0) {
      await panel.scrollIntoViewIfNeeded();
      console.log(`[${size.name}] Resubmissions panel present — scrolled into view.`);
    } else {
      console.log(`[${size.name}] Resubmissions panel NOT present (0 rows in this snapshot) — screenshotting dashboard top instead.`);
    }
    const dashPath = `/tmp/triage-resub-dashboard-${size.name}.png`;
    await page.screenshot({ path: dashPath, fullPage: false });
    console.log(`[${size.name}] saved ${dashPath}`);

    // 2. One assessment page via a late-work/make-up/resubmission row's href.
    const rowLink = page.locator('a[href*="/assessment/"][href*="student="]').first();
    const linkCount = await rowLink.count();
    if (linkCount > 0) {
      const href = await rowLink.getAttribute('href');
      await page.goto(`${BASE_URL}${href}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(800);
      const assessPath = `/tmp/triage-resub-assessment-${size.name}.png`;
      // Prefer a tight screenshot of the deep-linked student card itself
      // (stable id="student-card-{id}") — a full-page shot of the whole
      // roster is too tall to be useful here. Fall back to the viewport if
      // the card id isn't found (e.g. navigation didn't carry a ?student=).
      const studentIdMatch = href.match(/student=(\d+)/);
      const card = studentIdMatch ? page.locator(`#student-card-${studentIdMatch[1]}`) : page.locator('nope');
      if (await card.count() > 0) {
        await card.scrollIntoViewIfNeeded();
        await card.screenshot({ path: assessPath });
      } else {
        await page.screenshot({ path: assessPath, fullPage: false });
      }
      console.log(`[${size.name}] assessment row href=${href} saved ${assessPath}`);
    } else {
      console.log(`[${size.name}] No dashboard row with an assessment deep link found — skipping assessment screenshot.`);
    }

    await page.close();
  }
  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
