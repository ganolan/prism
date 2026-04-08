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
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getDb } from '../db/index.js';

const SCHOOLOGY_BASE = 'https://schoology.hkis.edu.hk';
const GRADING_SCALE_ID = 21337256; // HKIS General Academic Scale
const SESSION_DIR = join(process.cwd(), '.playwright-session');

const POINTS_TO_GRADE = { 100: 'ED', 75: 'EX', 50: 'D', 25: 'EM', 0: 'IE' };
const GRADE_TO_LABEL = {
  ED: 'Exhibiting Depth',
  EX: 'Exhibiting',
  D: 'Developing',
  EM: 'Emerging',
  IE: 'Insufficient Evidence',
};

/**
 * Open a Playwright browser using a dedicated session directory (NOT Chrome's
 * live profile, which is locked while Chrome is running).
 *
 * On first use, run `npm run mastery:login` to log in to Schoology in a
 * visible browser window — the session is saved to .playwright-session/.
 */
async function openPage() {
  if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
  const browser = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: true,
  });
  const page = browser.pages()[0] || await browser.newPage();
  return { browser, page };
}

/**
 * After navigating to a Schoology page, check if we landed on a login page
 * (session expired or never logged in). Returns true if logged in OK.
 */
async function checkLoggedIn(page) {
  const url = page.url();
  // Schoology redirects to /login or an SSO provider when not authenticated
  if (url.includes('/login') || url.includes('accounts.google.com') || url.includes('saml') || url.includes('sso')) {
    return false;
  }
  // Also check if the page body contains a login form
  const hasLoginForm = await page.evaluate(() => {
    return !!document.querySelector('#edit-name, form[action*="login"], .login-form');
  }).catch(() => false);
  return !hasLoginForm;
}

/**
 * Open a VISIBLE browser for the user to log in to Schoology.
 * Called via `npm run mastery:login` or `POST /api/mastery/login`.
 */
export async function interactiveLogin() {
  if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
  console.log('[masterySync] Opening browser for Schoology login...');
  console.log('[masterySync] Log in to Schoology, then close the browser window.');
  const browser = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: false,
  });
  const page = browser.pages()[0] || await browser.newPage();
  await page.goto(`${SCHOOLOGY_BASE}/home`, { waitUntil: 'domcontentloaded' });

  // Wait for the user to close the browser
  await new Promise(resolve => browser.on('close', resolve));
  console.log('[masterySync] Browser closed. Session saved.');
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

  const { browser, page } = await openPage();

  try {
    // ── Step 1: Get building_id from the mastery page ──────────────────────
    log('Navigating to district mastery page...');
    await page.goto(`${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Check if we're logged in
    const loggedIn = await checkLoggedIn(page);
    if (!loggedIn) {
      throw new Error(
        'Not logged in to Schoology. Run `npm run mastery:login` first to authenticate, then try syncing again.'
      );
    }
    log('Logged in OK');

    // Extract building_id from the page's data or URL params used by the app
    const buildingId = await page.evaluate(() => {
      // Schoology embeds school/building context in the DOM
      const el = document.querySelector('[data-building-id]');
      if (el) return el.getAttribute('data-building-id');
      // Fallback: look in window globals
      if (window.sSchoolId) return window.sSchoolId;
      if (window.Drupal?.settings?.s_common?.school_id) return window.Drupal.settings.s_common.school_id;
      return null;
    });

    if (!buildingId) {
      // Try fetching aligned-objectives with just section_id — building_id may be optional
      log('Warning: could not find building_id; will attempt without it');
    } else {
      log(`Found building_id: ${buildingId}`);
    }

    // ── Step 2: Fetch reporting categories + measurement topics ────────────
    const objectivesUrl = buildingId
      ? `${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/aligned-objectives?building_id=${buildingId}&section_id=${sectionId}`
      : `${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/aligned-objectives?section_id=${sectionId}`;

    log('Fetching aligned objectives...');
    const objectivesData = await fetchInternal(page, objectivesUrl);

    // objectivesData shape: { data: [ { id, external_id, title, weight, objectives: [...] } ] }
    const categories = objectivesData.data || [];
    log(`Found ${categories.length} reporting categories`);

    // ── Step 3: Collect all material IDs across all topics ─────────────────
    const allMaterialIds = new Set();
    const allTopics = [];

    for (const cat of categories) {
      for (const topic of (cat.objectives || [])) {
        allTopics.push({ ...topic, categoryId: cat.id });
        // Observations may reference materials — we collect IDs after fetching
      }
    }

    // ── Step 4: Fetch observations per topic ───────────────────────────────
    log(`Fetching observations for ${allTopics.length} measurement topics...`);

    const observationsByTopic = {};
    for (const topic of allTopics) {
      const obsUrl = buildingId
        ? `${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/material-observations/search?building_id=${buildingId}&objective_id=${topic.id}&section_id=${sectionId}`
        : `${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/material-observations/search?objective_id=${topic.id}&section_id=${sectionId}`;

      const obsData = await fetchInternal(page, obsUrl);
      const observations = obsData.data || [];
      observationsByTopic[topic.id] = observations;

      for (const obs of observations) {
        const mid = obs.gradeable_material?.material_id;
        if (mid) allMaterialIds.add(String(mid));
      }

      log(`  ${topic.external_id} ${topic.title}: ${observations.length} observations`);
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
      upsertCategory.run(cat.id, courseId, cat.external_id || null, cat.title, cat.weight ?? null, now);
      categoriesCount++;

      for (const topic of (cat.objectives || [])) {
        upsertTopic.run(topic.id, cat.id, courseId, topic.external_id || null, topic.title, topic.weight ?? null, now);
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
