// Visual check (submission comments, 2026-10-17). Opens one assessment page on a
// running dev server, opens the thread of the first student who wrote text in a
// comment, and screenshots the card with its popover at desktop and phone width.
// Read-only: it never posts. Names and comment text are replaced on the page
// before each screenshot, so no student data reaches the image.
// Usage: BASE_URL=http://127.0.0.1:5173 OUT_DIR=<dir> node scripts/screenshot-submission-comments.mjs <courseId> <assignmentId>
import { chromium } from 'playwright';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5173';
const OUT_DIR = process.env.OUT_DIR || '.';
const [courseId, assignmentId] = process.argv.slice(2);
const SIZES = [{ name: 'desktop', width: 1280, height: 900 }, { name: 'phone', width: 390, height: 844 }];

function mask() {
  let n = 0;
  const names = new Map();
  const alias = (t) => { if (!names.has(t)) names.set(t, `Student ${String.fromCharCode(65 + (n++ % 26))}`); return names.get(t); };
  document.querySelectorAll('img').forEach((i) => { i.style.visibility = 'hidden'; });
  document.querySelectorAll('a.link').forEach((a) => { if (a.textContent.trim()) a.textContent = alias(a.textContent.trim()); });
  document.querySelectorAll('.comment-student-text').forEach((el) => {
    const tag = el.querySelector('.comment-student-tag');
    el.textContent = 'Playtest: (the student\'s own text, hidden in this screenshot)\nEvaluation: (hidden)';
    if (tag) el.prepend(tag);
  });
  document.querySelectorAll('.comment-text').forEach((el) => { el.textContent = '(teacher comment, hidden in this screenshot)'; });
  document.querySelectorAll('.comment-meta b').forEach((b) => { if (b.textContent !== 'You') b.textContent = 'Student A'; });
  const label = document.querySelector('.comment-label'); if (label) label.textContent = 'Reply to Student A';
  const dlg = document.querySelector('.comment-pop'); if (dlg) dlg.setAttribute('aria-label', 'Submission comments');
}

const browser = await chromium.launch();
for (const size of SIZES) {
  const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
  await page.goto(`${BASE_URL}/course/${courseId}/assessment/${assignmentId}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.comment-chip', { timeout: 20000 });
  const wrote = page.locator('.comment-wrote').first();
  if (!(await wrote.count())) { console.log(`[${size.name}] no student wrote text in a comment`); continue; }
  const chip = wrote.locator('xpath=preceding-sibling::button[contains(@class,"comment-chip")][1]');
  await chip.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -80));
  await chip.click();
  await page.waitForSelector('.comment-student-text', { timeout: 20000 });
  await page.evaluate(mask);
  const path = `${OUT_DIR}/submission-comments-${size.name}.png`;
  await page.screenshot({ path });
  console.log(`[${size.name}] ${path}`);
  await page.close();
}
await browser.close();
