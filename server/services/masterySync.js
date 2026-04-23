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
 * POST JSON to an internal district_mastery API endpoint. These POSTs require
 * both X-CSRF-Token and X-CSRF-Key, read from Drupal.settings.s_common in the
 * page. Without them the server returns 403 {"data":null}.
 */
async function postInternal(page, url, body) {
  return page.evaluate(async ({ url, body }) => {
    const csrf = {
      token: window.Drupal?.settings?.s_common?.csrf_token,
      key: window.Drupal?.settings?.s_common?.csrf_key,
    };
    if (!csrf.token || !csrf.key) throw new Error('CSRF token/key missing from Drupal.settings.s_common');
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-Token': csrf.token,
        'X-CSRF-Key': csrf.key,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for POST ${url}`);
    return res.json();
  }, { url, body });
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

    // ── Step 3.5: Fetch authoritative (topic ↔ assignment) alignments ──────
    // Using POST /alignments/search rather than inferring from scores means
    // we see alignments even for assignments nobody has been graded on yet.
    const alignmentRows = []; // { assignment_schoology_id, topic_id }
    if (allTopics.length) {
      try {
        const alignUrl = `${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/alignments/search`;
        const alignData = await postInternal(page, alignUrl, {
          building_id: Number(buildingId),
          section_id: Number(sectionId),
          objective_ids: allTopics.map(t => t.id).join(','),
          include_gradeable_materials_only: true,
        });
        for (const a of (alignData.data || [])) {
          const matId = a.gradeable_material?.material?.id;
          const topicId = a.objective?.id;
          if (matId && topicId) {
            alignmentRows.push({
              assignment_schoology_id: String(matId),
              topic_id: String(topicId),
            });
          }
        }
        log(`  Got ${alignmentRows.length} topic↔assignment alignments`);
      } catch (err) {
        log(`Warning: alignments/search failed: ${err.message}`);
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

    // ── Step 5.5: Fetch Schoology's per-(student, objective) rollups ───────
    // This is what the Schoology mastery gradebook UI displays — the
    // "officially reported" level for each student per measurement topic and
    // per reporting category. Includes teacher overrides.
    const rollupRows = []; // { student_uid, objective_id, is_category, grade_percentage, grade_scaled_rounded, override_value }
    const studentUidSet = new Set();
    for (const obsList of Object.values(observationsByTopic)) {
      for (const o of obsList) studentUidSet.add(String(o.student_uid));
    }
    const studentUids = [...studentUidSet];
    const categoryIdSet = new Set(categories.map(c => c.id));
    const allObjectiveIds = [...categoryIdSet, ...allTopics.map(t => t.id)];

    if (studentUids.length && allObjectiveIds.length) {
      log(`Fetching Schoology rollups for ${studentUids.length} students × ${allObjectiveIds.length} objectives...`);
      try {
        const rollupUrl = `${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/outcomes/objectives`;
        const rollupData = await postInternal(page, rollupUrl, {
          building_id: Number(buildingId),
          section_id: Number(sectionId),
          student_uids: studentUids.join(','),
          ids: allObjectiveIds.join(','),
        });

        for (const row of (rollupData.data || [])) {
          const objId = row.objective_id;
          const isCategory = categoryIdSet.has(objId) ? 1 : 0;
          for (const so of (row.student_outcomes || [])) {
            const outcome = so.outcome || {};
            const ov = so.outcome_override;
            // Override shape unknown (never non-null in observed data) — store
            // numeric value if plain number, else stringify for later inspection.
            let overrideValue = null;
            if (ov != null) {
              if (typeof ov === 'number') overrideValue = ov;
              else if (typeof ov === 'object') overrideValue = Number(ov.grade_scaled_rounded ?? ov.grade_percentage ?? ov.value ?? NaN) || null;
            }
            rollupRows.push({
              student_uid: String(so.student_uid),
              objective_id: objId,
              is_category: isCategory,
              grade_percentage: outcome.grade_percentage != null ? Number(outcome.grade_percentage) : null,
              grade_scaled_rounded: outcome.grade_scaled_rounded != null ? Number(outcome.grade_scaled_rounded) : null,
              override_value: overrideValue,
            });
          }
        }
        log(`  Got ${rollupRows.length} rollup rows`);
      } catch (err) {
        log(`Warning: rollup fetch failed: ${err.message}`);
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

    // Persist authoritative alignments. Clear this course's alignments first
    // so removed topic↔assignment pairs don't linger.
    if (alignmentRows.length > 0) {
      db.prepare(`DELETE FROM mastery_alignments WHERE course_id = ?`).run(courseId);
    }
    const upsertAlignment = db.prepare(`
      INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id, synced_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(assignment_schoology_id, topic_id) DO UPDATE SET
        course_id = excluded.course_id,
        synced_at = excluded.synced_at
    `);
    let alignmentsCount = 0;
    for (const a of alignmentRows) {
      upsertAlignment.run(a.assignment_schoology_id, a.topic_id, courseId, now);
      alignmentsCount++;
    }

    // Persist Schoology rollups. Clear this course's rollups first so
    // students who no longer have a rollup (e.g. unenrolled) don't linger.
    const upsertRollup = db.prepare(`
      INSERT INTO mastery_rollups (student_uid, objective_id, course_id, is_category, grade_percentage, grade_scaled_rounded, override_value, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(student_uid, objective_id) DO UPDATE SET
        course_id = excluded.course_id,
        is_category = excluded.is_category,
        grade_percentage = excluded.grade_percentage,
        grade_scaled_rounded = excluded.grade_scaled_rounded,
        override_value = excluded.override_value,
        synced_at = excluded.synced_at
    `);
    let rollupsCount = 0;
    for (const r of rollupRows) {
      upsertRollup.run(
        r.student_uid, r.objective_id, courseId, r.is_category,
        r.grade_percentage, r.grade_scaled_rounded, r.override_value, now
      );
      rollupsCount++;
    }

    log(`Done: ${categoriesCount} categories, ${topicsCount} topics, ${scoresCount} scores, ${rollupsCount} rollups, ${alignmentsCount} alignments`);
    return { categoriesCount, topicsCount, scoresCount, rollupsCount, alignmentsCount, materialsCount: allMaterialIds.size };

  } finally {
    await browser.close();
  }
}

/**
 * Set or clear a Schoology mastery override for one (student, objective).
 * objectiveId can be a reporting-category UUID or a measurement-topic UUID.
 * Pass gradeScaled as one of "0.00"/"12.50"/"37.50"/"62.50"/"87.50" to set,
 * or null to clear.
 *
 * Endpoint: POST /course/{sectionId}/district_mastery/api/nodes/{objectiveId}/outcome-override
 */
export async function writeMasteryOverride({
  sectionId,
  buildingId,
  objectiveId,
  studentUid,
  gradeScaled,          // "87.50" | "62.50" | ... | null
  gradingScaleId = GRADING_SCALE_ID,
  gradingPeriodId = 0,
}) {
  const { browser, page } = await openPage();
  try {
    // Network-intercept building_id from the page's own XHR URLs — this is
    // what the sync uses. `Drupal.settings.s_common.school_id` is null in
    // this environment, so the DOM fallback doesn't work.
    let bId = buildingId ? String(buildingId) : null;
    if (!bId) {
      page.on('request', req => {
        const m = req.url().match(/building_id=(\d+)/);
        if (m && !bId) bId = m[1];
      });
    }
    await page.goto(`${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery`, {
      waitUntil: 'load',
    });
    if (!bId) throw new Error('Could not determine building_id for override write (no XHR with building_id seen during page load)');

    const url = `${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/nodes/${objectiveId}/outcome-override`;
    const body = {
      building_id: Number(bId),
      section_id: Number(sectionId),
      grading_period_id: Number(gradingPeriodId) || 0,
      student_uid: Number(studentUid),
      grade_scaled: gradeScaled,     // string or null
      grading_scale_id: Number(gradingScaleId),
    };
    const result = await postInternal(page, url, body);
    return result;
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

  // Derive topics and categories from actual scores for published assignments in this course
  const topics = db.prepare(`
    SELECT DISTINCT mt.* FROM measurement_topics mt
    WHERE mt.id IN (
      SELECT DISTINCT ms.topic_id FROM mastery_scores ms
      JOIN assignments a ON a.schoology_assignment_id = ms.assignment_schoology_id
      WHERE a.course_id = ? AND a.published = 1
    )
    ORDER BY mt.external_id
  `).all(courseId);

  const categoryIds = [...new Set(topics.map(t => t.category_id))];
  const categories = categoryIds.length > 0 ? db.prepare(`
    SELECT * FROM reporting_categories WHERE id IN (${categoryIds.map(() => '?').join(',')})
    ORDER BY external_id
  `).all(...categoryIds) : [];

  const scores = topics.length > 0 ? db.prepare(`
    SELECT ms.*, s.first_name, s.last_name, s.preferred_name, s.schoology_uid
    FROM mastery_scores ms
    JOIN students s ON s.schoology_uid = ms.student_uid
    JOIN assignments a ON a.schoology_assignment_id = ms.assignment_schoology_id
    LEFT JOIN folders f ON f.schoology_folder_id = a.folder_id AND f.course_id = a.course_id
    LEFT JOIN folders fp ON fp.schoology_folder_id = f.parent_id AND fp.course_id = f.course_id AND f.parent_id != '0'
    WHERE a.course_id = ? AND a.published = 1
    ORDER BY ms.student_uid, ms.topic_id,
      CASE WHEN a.folder_id IS NULL OR a.folder_id = '0' THEN a.display_weight
           WHEN f.parent_id IS NOT NULL AND f.parent_id != '0' THEN COALESCE(fp.display_weight, 0)
           ELSE COALESCE(f.display_weight, a.display_weight) END ASC,
      CASE WHEN a.folder_id IS NULL OR a.folder_id = '0' THEN 0
           WHEN f.parent_id IS NOT NULL AND f.parent_id != '0' THEN COALESCE(f.display_weight, 0)
           ELSE a.display_weight END ASC,
      CASE WHEN f.parent_id IS NOT NULL AND f.parent_id != '0' THEN a.display_weight ELSE 0 END ASC,
      ms.assignment_schoology_id
  `).all(courseId) : [];

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
