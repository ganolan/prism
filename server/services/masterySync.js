/**
 * masterySync.js
 *
 * Playwright-based service for reading and writing mastery (SBG) data via
 * Schoology's internal school-domain APIs. These endpoints are not available
 * through the public OAuth API.
 *
 * READ:  GET /course/{id}/district_mastery/api/aligned-objectives
 *        GET /course/{id}/district_mastery/api/material-observations/search
 *        GET /iapi2/district-mastery/course/{id}/materials
 *
 * WRITE: POST /iapi2/district-mastery/course/{courseId}/observations
 *
 * Requires a live browser session — launches with the user's existing Chrome
 * profile so no separate login is needed.
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getDb } from '../db/index.js';

const SCHOOLOGY_BASE = 'https://schoology.hkis.edu.hk';
const GRADING_SCALE_ID = 21337256; // HKIS General Academic Scale
const SESSION_DIR = join(process.cwd(), '.playwright-session');
const STATE_FILE = join(SESSION_DIR, 'storage-state.json');

const POINTS_TO_GRADE = { 100: 'ED', 75: 'EX', 50: 'D', 25: 'EM', 0: 'IE' };
const GRADE_TO_LABEL = {
  ED: 'Exhibiting Depth',
  EX: 'Exhibiting',
  D: 'Developing',
  EM: 'Emerging',
  IE: 'Insufficient Evidence',
};

/**
 * Launch a headless browser with saved Schoology session cookies.
 * Uses explicit storageState (a JSON file of cookies + localStorage)
 * rather than a persistent context directory, which avoids profile
 * lock issues and headed-vs-headless cookie mismatches.
 */
async function openPage() {
  const browser = await chromium.launch({ headless: true });
  const contextOpts = {};
  if (existsSync(STATE_FILE)) {
    contextOpts.storageState = STATE_FILE;
  }
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  return { browser, page, context };
}

/**
 * After navigating to a Schoology course page, check if we actually landed
 * there or got redirected to a login/SSO page.
 */
function checkLoggedIn(page) {
  const url = page.url();
  // If we're still on the intended course page, we're logged in
  if (url.includes('/district_mastery') || url.includes('/course/')) return true;
  // Anything else (login page, SSO redirect, etc.) means not logged in
  return false;
}

/**
 * Open a VISIBLE browser for the user to log in to Schoology.
 * Auto-detects when login completes (URL returns to Schoology home),
 * saves cookies to a JSON file, then closes the browser automatically.
 * No manual close needed.
 */
export async function interactiveLogin() {
  if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
  console.log('[masterySync] Opening browser for Schoology login...');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${SCHOOLOGY_BASE}/home`, { waitUntil: 'domcontentloaded' });

  // Wait until the user has logged in and landed back on Schoology
  console.log('[masterySync] Waiting for login to complete...');
  try {
    await page.waitForURL(
      url => {
        const s = url.toString();
        return s.includes('schoology.hkis.edu.hk') &&
               !s.includes('/login') &&
               !s.includes('/saml') &&
               !s.includes('accounts.google.com');
      },
      { timeout: 300000 } // 5 minute timeout
    );
  } catch {
    await browser.close();
    throw new Error('Login timed out after 5 minutes. Please try again.');
  }

  // Wait a moment for any final cookie-setting redirects
  await page.waitForTimeout(2000);

  // Save cookies + localStorage to a portable JSON file
  const state = await context.storageState();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  await browser.close();
  console.log('[masterySync] Login complete. Session saved.');
}

/**
 * Fetch JSON from a Schoology internal API endpoint using an existing
 * browser page (inherits cookies/session).
 */
async function fetchInternal(page, url) {
  const result = await page.evaluate(async (fetchUrl) => {
    const res = await fetch(fetchUrl, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${fetchUrl}`);
    return res.json();
  }, url);
  return result;
}

/**
 * Get building_id and section_id needed for district_mastery API calls.
 * These come from the course's Schoology section data already in the DB.
 */
function getCourseRow(db, courseId) {
  return db.prepare('SELECT * FROM courses WHERE id = ?').get(courseId);
}

/**
 * Sync all mastery data for a course from Schoology into the local DB.
 *
 * @param {number|string} courseId — Prism internal course ID
 * @param {object} opts
 * @param {Function} [opts.onProgress] — called with { message } as work proceeds
 * @returns {{ categories, topics, assignments, scores }}
 */
export async function syncMasteryForCourse(courseId, { onProgress } = {}) {
  const log = (msg) => {
    console.log(`[masterySync] ${msg}`);
    onProgress?.({ message: msg });
  };

  const db = getDb();
  const courseRow = getCourseRow(db, courseId);
  if (!courseRow) throw new Error(`Course ${courseId} not found in DB`);

  const sectionId = courseRow.schoology_section_id;
  log(`Starting mastery sync for course ${courseRow.course_name} (section ${sectionId})`);

  let { browser, page } = await openPage();

  try {
    // ── Step 1: Navigate and extract building_id ────────────────────────────
    log('Navigating to district mastery page...');

    // Intercept the page's own API requests to capture building_id
    let buildingId = null;
    page.on('request', req => {
      const match = req.url().match(/building_id=(\d+)/);
      if (match) buildingId = match[1];
    });

    await page.goto(`${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery`, {
      waitUntil: 'load',
      timeout: 30000,
    });

    // Check if we're logged in — if not, open a visible browser for the user
    const loggedIn = checkLoggedIn(page);
    if (!loggedIn) {
      log('Not logged in — opening browser for Schoology login...');
      await browser.close();

      // Open a visible browser so the user can log in to Schoology
      await interactiveLogin();

      // Re-open headless and retry navigation
      ({ browser, page } = await openPage());
      page.on('request', req => {
        const match = req.url().match(/building_id=(\d+)/);
        if (match) buildingId = match[1];
      });
      await page.goto(`${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery`, {
        waitUntil: 'load',
        timeout: 30000,
      });
      if (!checkLoggedIn(page)) {
        throw new Error('Still not logged in after login attempt. Please try again.');
      }
    }
    log('Logged in OK');

    // If network interception didn't capture building_id, try DOM/globals
    if (!buildingId) {
      try {
        // Wait for Drupal settings to initialize
        await page.waitForFunction(
          () => window.Drupal?.settings?.s_common?.school_id || window.sSchoolId,
          { timeout: 10000 }
        );
        buildingId = await page.evaluate(() => {
          return String(window.Drupal?.settings?.s_common?.school_id || window.sSchoolId || '');
        });
      } catch {
        log('Warning: Drupal settings not found, trying data attributes...');
        buildingId = await page.evaluate(() => {
          const el = document.querySelector('[data-building-id]');
          return el ? el.getAttribute('data-building-id') : null;
        });
      }
    }

    if (!buildingId) {
      throw new Error('Could not determine building_id from the mastery page. The page may not have loaded correctly.');
    }
    log(`Found building_id: ${buildingId}`);

    // ── Step 2: Fetch reporting categories + measurement topics ────────────
    const objectivesUrl = `${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/aligned-objectives?building_id=${buildingId}&section_id=${sectionId}`;

    log('Fetching aligned objectives...');
    const objectivesData = await fetchInternal(page, objectivesUrl);

    // The API may return data under different keys depending on version
    const categories = objectivesData.data || objectivesData || [];
    log(`Found ${categories.length} reporting categories`);
    if (categories.length > 0) {
      log(`  Category keys: ${Object.keys(categories[0]).join(', ')}`);
    }

    // ── Step 3: Collect all material IDs across all topics ─────────────────
    const allMaterialIds = new Set();
    const allTopics = [];

    for (const cat of categories) {
      // Topics may be under: objectives, measurementTopics, measurement_topics, children
      const topics = cat.child_objectives || cat.objectives || cat.measurementTopics || cat.measurement_topics || cat.children || [];
      for (const topic of topics) {
        allTopics.push({ ...topic, categoryId: cat.id });
      }
    }

    // ── Step 4: Fetch observations per topic ───────────────────────────────
    log(`Fetching observations for ${allTopics.length} measurement topics...`);

    const observationsByTopic = {};
    for (const topic of allTopics) {
      const obsUrl = `${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/material-observations/search?building_id=${buildingId}&objective_id=${topic.id}&section_id=${sectionId}`;

      const obsData = await fetchInternal(page, obsUrl);
      const observations = obsData.data || [];
      observationsByTopic[topic.id] = observations;

      for (const obs of observations) {
        const mid = obs.gradeable_material?.material_id;
        if (mid) allMaterialIds.add(String(mid));
      }

      log(`  ${topic.external_id || topic.externalId || topic.id} ${topic.title}: ${observations.length} observations`);
    }

    // ── Step 5: Fetch full assignment names ────────────────────────────────
    const materialMap = {}; // materialId -> { title, gradingPeriodId, gradingCategoryId }

    if (allMaterialIds.size > 0) {
      log(`Fetching names for ${allMaterialIds.size} assignments...`);
      const ids = [...allMaterialIds];
      const params = ids.map((id, i) => `material_id_types[${i}]=${id}|ASSIGNMENT`).join('&');
      const materialsUrl = `${SCHOOLOGY_BASE}/iapi2/district-mastery/course/${sectionId}/materials?${params}`;

      try {
        const materialsData = await fetchInternal(page, materialsUrl);
        const materials = materialsData.data || materialsData.materials || [];
        for (const m of materials) {
          materialMap[String(m.id || m.material_id)] = {
            title: m.title,
            gradingPeriodId: m.grading_period_id || m.gradingPeriodId || null,
            gradingCategoryId: m.grading_category_id || m.gradingCategoryId || null,
          };
        }
      } catch (err) {
        log(`Warning: could not fetch material names: ${err.message}`);
      }
    }

    // ── Step 6: Persist to DB ──────────────────────────────────────────────
    log('Writing to database...');
    const now = new Date().toISOString();

    const upsertCategory = db.prepare(`
      INSERT INTO reporting_categories (id, course_id, external_id, title, weight, synced_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        external_id = excluded.external_id,
        title = excluded.title,
        weight = excluded.weight,
        synced_at = excluded.synced_at
    `);

    const upsertTopic = db.prepare(`
      INSERT INTO measurement_topics (id, category_id, course_id, external_id, title, weight, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        category_id = excluded.category_id,
        external_id = excluded.external_id,
        title = excluded.title,
        weight = excluded.weight,
        synced_at = excluded.synced_at
    `);

    const upsertScore = db.prepare(`
      INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade, synced_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(student_uid, assignment_schoology_id, topic_id) DO UPDATE SET
        points = excluded.points,
        grade = excluded.grade,
        synced_at = excluded.synced_at
    `);

    let categoriesCount = 0;
    let topicsCount = 0;
    let scoresCount = 0;

    for (const cat of categories) {
      upsertCategory.run(cat.id, courseId, cat.external_id || cat.externalId || null, cat.title, cat.weight ?? null, now);
      categoriesCount++;

      const catTopics = cat.child_objectives || cat.objectives || cat.measurementTopics || cat.measurement_topics || cat.children || [];
      for (const topic of catTopics) {
        upsertTopic.run(topic.id, cat.id, courseId, topic.external_id || topic.externalId || null, topic.title, topic.weight ?? null, now);
        topicsCount++;

        const observations = observationsByTopic[topic.id] || [];
        for (const obs of observations) {
          const uid = String(obs.student_uid);
          const assignId = String(obs.gradeable_material?.material_id);
          const points = obs.points ?? null;
          const grade = points !== null ? (POINTS_TO_GRADE[points] ?? null) : null;
          upsertScore.run(uid, assignId, topic.id, points, grade, now);
          scoresCount++;
        }
      }
    }

    // Update assignment metadata (title, grading period/category) from materialMap
    const upsertAssignment = db.prepare(`
      INSERT INTO assignments (course_id, schoology_assignment_id, title, max_points, assignment_type, mastery_grading_period_id, mastery_grading_category_id, synced_at)
      VALUES (?, ?, ?, 100, 'summative', ?, ?, ?)
      ON CONFLICT(schoology_assignment_id) DO UPDATE SET
        title = CASE WHEN excluded.title IS NOT NULL AND excluded.title != '' THEN excluded.title ELSE assignments.title END,
        max_points = 100,
        assignment_type = 'summative',
        mastery_grading_period_id = COALESCE(excluded.mastery_grading_period_id, assignments.mastery_grading_period_id),
        mastery_grading_category_id = COALESCE(excluded.mastery_grading_category_id, assignments.mastery_grading_category_id),
        synced_at = excluded.synced_at
    `);

    for (const [mid, info] of Object.entries(materialMap)) {
      if (info.title) {
        upsertAssignment.run(
          courseId, mid, info.title,
          info.gradingPeriodId ? String(info.gradingPeriodId) : null,
          info.gradingCategoryId ? String(info.gradingCategoryId) : null,
          now
        );
      }
    }

    log(`Done: ${categoriesCount} categories, ${topicsCount} topics, ${scoresCount} scores`);
    return { categoriesCount, topicsCount, scoresCount, materialsCount: allMaterialIds.size };

  } finally {
    await browser.close();
  }
}

/**
 * Write mastery scores for one student+assignment back to Schoology.
 *
 * @param {object} params
 * @param {string} params.courseId — Prism internal course ID
 * @param {string} params.sectionId — Schoology section ID
 * @param {string|number} params.enrollmentId — Schoology enrollment ID (schoology_enrolment_id)
 * @param {string|number} params.assignmentId — Schoology assignment ID (materialId)
 * @param {object} params.gradeInfo — { [topicUUID]: { grade: "75.00", gradingScaleId: 21337256 } }
 * @param {string|number} params.gradingPeriodId
 * @param {string|number} params.gradingCategoryId
 */
export async function writeMasteryScores({
  sectionId,
  enrollmentId,
  assignmentId,
  gradeInfo,
  gradingPeriodId,
  gradingCategoryId,
}) {
  const { browser, page } = await openPage();

  try {
    // Navigate to the course to establish session context
    await page.goto(`${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery`, {
      waitUntil: 'domcontentloaded',
    });

    const url = `${SCHOOLOGY_BASE}/iapi2/district-mastery/course/${sectionId}/observations`;
    const payload = {
      enrollmentId: Number(enrollmentId),
      gradeInfo,
      gradeItemId: Number(assignmentId),
      isGradebook: true,
      materialId: Number(assignmentId),
      materialType: 'ASSIGNMENT',
      maxPoints: 100,
      overrideGrade: null,
      isCollectedOnly: false,
      gradingPeriodId: Number(gradingPeriodId),
      gradingCategoryId: Number(gradingCategoryId),
    };

    const result = await page.evaluate(async ({ url, payload }) => {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
      return JSON.parse(text);
    }, { url, payload });

    return result;
  } finally {
    await browser.close();
  }
}

/**
 * Get all mastery scores for a course, grouped by student and topic.
 * Returns data ready for the UI: students with per-topic arrays.
 */
export function getMasteryForCourse(courseId) {
  const db = getDb();

  const categories = db.prepare(`
    SELECT * FROM reporting_categories WHERE course_id = ? ORDER BY external_id
  `).all(courseId);

  const topics = db.prepare(`
    SELECT * FROM measurement_topics WHERE course_id = ? ORDER BY external_id
  `).all(courseId);

  const scores = db.prepare(`
    SELECT ms.*, s.first_name, s.last_name, s.preferred_name, s.schoology_uid
    FROM mastery_scores ms
    JOIN students s ON s.schoology_uid = ms.student_uid
    JOIN measurement_topics mt ON mt.id = ms.topic_id
    WHERE mt.course_id = ?
    ORDER BY ms.student_uid, ms.topic_id, ms.assignment_schoology_id
  `).all(courseId);

  return { categories, topics, scores };
}

/**
 * Get current per-topic mastery scores for one student on one assignment.
 * Used to pre-populate the grading panel before writing.
 *
 * Endpoint: GET /course/{sectionId}/district_mastery/api/observations/search
 *   ?student_uids={uid}&section_id={sectionId}&material_type=ASSIGNMENT&material_id={assignmentId}
 *
 * Returns an array of { alignment_id (= topic UUID), points, grade_percentage, ... }
 */
export async function getRubricScoresForStudent({ sectionId, studentUid, assignmentId }) {
  const { browser, page } = await openPage();

  try {
    await page.goto(`${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery`, {
      waitUntil: 'domcontentloaded',
    });

    const url =
      `${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/observations/search` +
      `?student_uids=${studentUid}&section_id=${sectionId}&material_type=ASSIGNMENT&material_id=${assignmentId}`;

    const data = await fetchInternal(page, url);
    return data.data || [];
  } finally {
    await browser.close();
  }
}

export { POINTS_TO_GRADE, GRADE_TO_LABEL, GRADING_SCALE_ID };
