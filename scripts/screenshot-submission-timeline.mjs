// Screenshots of the submission timeline + lesson hint against a running Prism.
// Usage: BASE_URL=http://127.0.0.1:3002 COURSE=579 ASSIGNMENT=8489385833 STUDENT=80 node scripts/screenshot-submission-timeline.mjs
import { chromium } from 'playwright';

const { BASE_URL = 'http://127.0.0.1:3002', COURSE, ASSIGNMENT, STUDENT, OUT = '/tmp/shots' } = process.env;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });

  // 1. /assessment/ card, scrolled to the student, with the Ask to resubmit panel open.
  await page.goto(`${BASE_URL}/course/${COURSE}/assessment/${ASSIGNMENT}?student=${STUDENT}`, { waitUntil: 'networkidle' });
  const row = page.locator('[data-testid="submission-timeline"]').first();
  await row.waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);
  const card = row.locator('xpath=ancestor::div[contains(@style,"border-radius")][1]');
  await page.screenshot({ path: `${OUT}/1-assessment-page.png` });
  const ask = page.locator('button.resubmit-pill').first();
  if (await ask.count()) {
    await ask.click();
    await page.locator('[data-testid="lesson-hint"]').first().waitFor({ timeout: 10000 });
    await (await card.count() ? card : row).screenshot({ path: `${OUT}/2-card-with-lesson-hint.png` });
  }

  // 2. Student page course table.
  await page.goto(`${BASE_URL}/student/${STUDENT}`, { waitUntil: 'networkidle' });
  await page.locator('[data-testid="submission-timeline"]').first().waitFor({ timeout: 15000 });
  const table = page.locator('table').filter({ has: page.locator('[data-testid="submission-timeline"]') }).first();
  await table.screenshot({ path: `${OUT}/3-student-page.png` });
  console.log('done');
} finally {
  await browser.close();
}
