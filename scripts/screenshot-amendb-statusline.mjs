// Visual check (Amendment B, Task 8). Screenshots the Dashboard's Resubmissions
// panel and the StatusLineModal confirm (opened via "Grade stands" on a red
// Waiting row) at phone + desktop widths, against a running dev server seeded
// per the task-8 brief (one red Waiting row past its deadline, one Waiting row
// still in time, one Arrived row). READ-ONLY: the modal's own fetch is a
// Schoology read (previewStatusLine); this script never clicks Publish/Confirm —
// it screenshots the open modal, then presses Cancel. Run from the repo root so
// Playwright resolves its node_modules.
// Usage: BASE_URL=http://localhost:5173 node scripts/screenshot-amendb-statusline.mjs
import { chromium } from 'playwright';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const SIZES = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 900 },
];

async function main() {
  const browser = await chromium.launch();
  for (const size of SIZES) {
    const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
    page.on('console', (msg) => { if (msg.type() === 'error') console.log(`[${size.name}] console error:`, msg.text()); });

    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    const panel = page.locator('section[aria-label="Resubmissions"]');
    if (await panel.count() === 0) {
      console.log(`[${size.name}] Resubmissions panel NOT present — seed may be missing. Aborting this size.`);
      await page.close();
      continue;
    }
    await panel.scrollIntoViewIfNeeded();
    const panelPath = `/tmp/amendb-resubmissions-panel-${size.name}.png`;
    await panel.screenshot({ path: panelPath });
    console.log(`[${size.name}] saved ${panelPath}`);

    // Open the StatusLineModal via the red Waiting row's "Grade stands" button.
    // This fires previewStatusLine (a Schoology read) — never a write.
    const gradeStandsBtn = page.getByRole('button', { name: 'Grade stands' }).first();
    if (await gradeStandsBtn.count() === 0) {
      console.log(`[${size.name}] No "Grade stands" button found — seed missing the red Waiting row. Skipping modal shot.`);
      await page.close();
      continue;
    }
    await gradeStandsBtn.click();
    const dialog = page.locator('[role="dialog"].status-line-modal');
    await dialog.waitFor({ state: 'visible' });
    // Wait for the fresh-read preview to resolve (textarea goes read-only while busy;
    // the "Reading their comment..." placeholder disappears once preview lands).
    await page.waitForFunction(() => {
      const el = document.querySelector('.status-line-modal');
      return el && el.textContent && el.textContent.includes('Their comment will read');
    }, { timeout: 15000 }).catch(() => console.log(`[${size.name}] preview did not resolve in time — screenshotting as-is`));
    await page.waitForTimeout(300);
    const modalPath = `/tmp/amendb-statusline-modal-${size.name}.png`;
    await page.screenshot({ path: modalPath, fullPage: false });
    console.log(`[${size.name}] saved ${modalPath}`);

    // Never publish — Cancel only.
    const cancelBtn = page.getByRole('button', { name: 'Cancel' });
    if (await cancelBtn.count() > 0) await cancelBtn.click();

    await page.close();
  }
  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
