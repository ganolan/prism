/**
 * masterySync.js
 *
 * Reads and writes mastery (SBG) data via Schoology's internal school-domain
 * APIs. These endpoints are not available through the public OAuth API.
 *
 * READ (plain HTTP with the saved session's cookies, no browser, #141;
 * openMasteryReader, checked with scripts/parity-mastery-reads.js):
 *        GET  /course/{id}/district_mastery (building id + CSRF pair)
 *        GET  /course/{id}/district_mastery/api/aligned-objectives
 *        POST /course/{id}/district_mastery/api/alignments/search
 *        POST /course/{id}/district_mastery/api/material-observations/search
 *        GET  /course/{id}/district_mastery/api/material-observations/search (one topic)
 *        GET  /iapi2/district-mastery/course/{id}/materials
 *        POST /course/{id}/district_mastery/api/outcomes/objectives
 *        GET  /course/{id}/district_mastery/api/observations/search (one student)
 *
 * WRITE (plain HTTP through the same client, the page's CSRF pair; #141):
 *        POST /iapi2/district-mastery/course/{courseId}/observations,
 *        POST /course/{id}/district_mastery/api/nodes/{objectiveId}/outcome-override
 *
 * Signing in: Settings → Log in to Schoology (RemoteSignIn, any device);
 * interactiveLogin (a visible browser) is left only for `npm run mastery:login`.
 */

// Playwright is loaded lazily inside interactiveLogin, the one function left that
// launches a browser (reads and writes are plain HTTP, #141). A top-level `import 'playwright'`
// would run at server boot and pull in chromium's whole module graph for
// every dev start — and on Node 25 the chromium ESM bridge can hang the
// import indefinitely, blocking the Express server from binding its port.
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getDb } from '../db/index.js';
import { getAssignmentGrades } from './schoology.js';
import { courseSectionIds, assertSectionWritable } from './courseSections.js';
import { groupObservationsByTopic, normalizeObservation } from '../lib/masteryObservations.js';
import { pointsToLevel, levelToLabel, schoologyScaleId } from '../lib/proficiencyScale.js';
import { sessionStateFile, ensureSessionDir } from '../lib/sessionPaths.js';
import { noteSessionLive } from './schoologySession.js';
import { cookieJar, getPage, getJson, postJson, drupalSettings, WebSessionError } from './schoologyWeb.js';

const SCHOOLOGY_BASE = 'https://schoology.hkis.edu.hk';

// True if a saved Schoology browser session file exists on disk. Best-effort:
// the session may still be expired — this only reports presence, not validity.
export function hasMasterySession() {
  return existsSync(sessionStateFile());
}

/**
 * Open a VISIBLE browser for the user to log in to Schoology.
 * Auto-detects when login completes (URL returns to Schoology home),
 * saves cookies to a JSON file, then closes the browser automatically.
 * No manual close needed.
 */
export async function interactiveLogin() {
  ensureSessionDir();
  console.log('[masterySync] Opening browser for Schoology login...');

  const { chromium } = await import('playwright');
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
  writeFileSync(sessionStateFile(), JSON.stringify(state, null, 2));

  await browser.close();
  console.log('[masterySync] Login complete. Session saved.');
}

/**
 * Get building_id and section_id needed for district_mastery API calls.
 * These come from the course's Schoology section data already in the DB.
 */
function getCourseRow(db, courseId) {
  return db.prepare('SELECT * FROM courses WHERE id = ?').get(courseId);
}

// Swappable for tests: the saved session's cookies for plain HTTP.
export const masteryDeps = {
  web: () => ({ jar: cookieJar(), fetchImpl: fetch }),
};

// Signed out even after the silent renewal (getResource renews through Microsoft
// once): Microsoft wants a real sign-in, which is Settings → Log in to Schoology
// (RemoteSignIn, any device).
const SIGN_IN_NEEDED = 'Not logged in to Schoology: the mastery session has expired. Log in to Schoology in Settings, then retry.';

// The building id the district_mastery API wants (97989879 for the HKIS HS
// building, not the school id): the page carries it as "buildingId" in its
// Drupal.settings (the React app's props), the value its own API calls send as
// building_id (#141). Falls back to a building_id= in the page markup.
export function masteryBuildingId(settings, html = '') {
  const seen = new Set();
  const walk = (v) => {
    if (!v || typeof v !== 'object' || seen.has(v)) return null;
    seen.add(v);
    if (v.buildingId != null && /^\d+$/.test(String(v.buildingId))) return String(v.buildingId);
    for (const x of Object.values(v)) { const hit = walk(x); if (hit) return hit; }
    return null;
  };
  return walk(settings)
    || html.match(/"buildingId"\s*:\s*"?(\d+)/)?.[1]
    || html.match(/building_id=(\d+)/)?.[1]
    || null;
}

/**
 * A client for one section's district_mastery API over plain HTTP with the saved
 * session's cookies (#141): the reads, and the writes (observations, overrides).
 * GETs /course/{sectionId}/district_mastery once for the building id and the CSRF
 * pair the POSTs need. `use` ('read' | 'write') names it in the session status.
 * Signed out (no saved session, or still sent to sign-in after getResource's silent
 * renewal, or a POST sent to sign-in): throws SIGN_IN_NEEDED, which points to Settings.
 * → { buildingId, getJson(url), postJson(url, body) }; getJson/postJson throw
 * "HTTP {status} for …" on a non-2xx answer, as the in-page fetches did. A POST is
 * sent once, never retried.
 */
export async function openMasteryReader(sectionId, use = 'read') {
  // #178: a mastery write to a section of a linked set would reach the wrong students' section.
  if (use === 'write') assertSectionWritable(getDb(), sectionId);
  const path = `/course/${sectionId}/district_mastery`;
  const open = async () => {
    let web;
    try { web = masteryDeps.web(); } catch { web = { jar: null }; }
    if (!web?.jar) throw new WebSessionError('SESSION_EXPIRED', 'No saved Schoology session');
    return { web, page: await getPage(web.jar, path, { fetchImpl: web.fetchImpl }) };
  };
  const signedOut = (err) => err instanceof WebSessionError && err.code === 'SESSION_EXPIRED';
  let opened;
  try {
    opened = await open();
  } catch (err) {
    if (!signedOut(err)) throw err;
    noteSessionLive('expired', `A mastery ${use} was sent to the login page`);
    throw new Error(SIGN_IN_NEEDED);
  }
  noteSessionLive('connected');
  const { web, page } = opened;
  const settings = drupalSettings(page.html);
  const buildingId = masteryBuildingId(settings, page.html);
  if (!buildingId) throw new Error('Could not determine building_id from the mastery page. The page may not have loaded correctly.');
  const io = { fetchImpl: web.fetchImpl };
  const ok = (r, what) => {
    if (r.status < 200 || r.status > 299) throw new Error(`HTTP ${r.status} for ${what}`);
    if (r.json == null) throw new Error(`No JSON in the answer for ${what}`);
    return r.json;
  };
  return {
    buildingId,
    getJson: async (url) => ok(await getJson(web.jar, url, io), url),
    postJson: async (url, body) => {
      let r;
      try {
        r = await postJson(web.jar, url, body, { ...io, csrf: settings?.s_common });
      } catch (err) {
        if (!signedOut(err)) throw err;
        noteSessionLive('expired', `A mastery ${use} was sent to the login page`);
        throw new Error(SIGN_IN_NEEDED);
      }
      return ok(r, `POST ${url}`);
    },
  };
}

/**
 * Sync all mastery data for a course from Schoology into the local DB.
 *
 * @param {number|string} courseId — Prism internal course ID
 * @param {object} opts
 * @param {Function} [opts.onProgress] — called with { message } as work proceeds
 * @returns {{ categories, topics, assignments, scores }}
 */
/**
 * Read one section's mastery data through a reader (openMasteryReader: plain
 * HTTP, #141): reporting categories + topics, alignments, observations, material
 * names and Schoology's rollups. Read-only (the POSTs are searches). Exported for
 * scripts/parity-mastery-reads.js, which runs it through the old browser transport.
 */
export async function readCourseMastery(reader, sectionId, log = () => {}) {
  const { buildingId } = reader;

  // ── Step 2: Fetch reporting categories + measurement topics ────────────
  const objectivesUrl = `${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/aligned-objectives?building_id=${buildingId}&section_id=${sectionId}`;

  log('Fetching aligned objectives...');
  const objectivesData = await reader.getJson(objectivesUrl);

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
      const alignData = await reader.postJson(alignUrl, {
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

  // ── Step 4: Fetch observations for ALL topics in ONE POST (#104) ────────
  // The per-topic GET loop (one call/topic) was the ~20–40s/course mastery
  // floor. The POST form of material-observations/search batches across
  // objective_ids (verified 2026-06-07); regroup by objective_id to rebuild
  // observationsByTopic exactly as the per-topic loop did.
  log(`Fetching observations for ${allTopics.length} measurement topics (batched POST)...`);
  let observationsByTopic = {};
  if (allTopics.length) {
    const obsUrl = `${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/material-observations/search`;
    const obsResp = await reader.postJson(obsUrl, {
      building_id: Number(buildingId),
      section_id: Number(sectionId),
      objective_ids: allTopics.map(t => t.id).join(','),
    });
    // The POST shape differs from the per-topic GET (gradeable_material.material.id
    // + string points) — normalize each row to the GET shape so the persist step
    // (which reads gradeable_material.material_id + numeric points) is unchanged.
    const allObs = (obsResp.data || []).map(normalizeObservation);
    observationsByTopic = groupObservationsByTopic(allObs, allTopics.map(t => t.id));
    for (const obs of allObs) {
      const mid = obs.gradeable_material?.material_id;
      if (mid) allMaterialIds.add(String(mid));
    }
    for (const topic of allTopics) {
      const n = (observationsByTopic[topic.id] || []).length;
      log(`  ${topic.external_id || topic.externalId || topic.id} ${topic.title}: ${n} observations`);
    }
  }

  // ── Step 5: Fetch full assignment names ────────────────────────────────
  const materialMap = {}; // materialId -> { title, gradingPeriodId, gradingCategoryId }

  if (allMaterialIds.size > 0) {
    log(`Fetching names for ${allMaterialIds.size} assignments...`);
    const ids = [...allMaterialIds];
    const params = ids.map((id, i) => `material_id_types[${i}]=${id}|ASSIGNMENT`).join('&');
    const materialsUrl = `${SCHOOLOGY_BASE}/iapi2/district-mastery/course/${sectionId}/materials?${params}`;

    try {
      const materialsData = await reader.getJson(materialsUrl);
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
      const rollupData = await reader.postJson(rollupUrl, {
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
          const overrideValue = overrideValueOf(so.outcome_override);
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

  return { categories, allTopics, alignmentRows, observationsByTopic, allMaterialIds, materialMap, rollupRows };
}

const topicsOf = (cat) => cat.child_objectives || cat.objectives || cat.measurementTopics || cat.measurement_topics || cat.children || [];

// The readCourseMastery answers of a course's sections as one (#178): each category and topic once
// (linked sections share the course's objectives), every section's observations and rollups (each
// section has its own students), and every alignment and task once.
export function mergeMasteryReads(reads) {
  if (reads.length === 1) return reads[0];
  const categories = new Map();
  for (const cat of reads.flatMap((r) => r.categories)) {
    const seen = categories.get(cat.id);
    if (!seen) { categories.set(cat.id, { ...cat, child_objectives: [...topicsOf(cat)] }); continue; }
    const ids = new Set(seen.child_objectives.map((t) => t.id));
    seen.child_objectives.push(...topicsOf(cat).filter((t) => !ids.has(t.id)));
  }
  const observationsByTopic = {};
  for (const r of reads) {
    for (const [topicId, list] of Object.entries(r.observationsByTopic)) {
      (observationsByTopic[topicId] ||= []).push(...list);
    }
  }
  const alignments = new Map();
  for (const a of reads.flatMap((r) => r.alignmentRows)) alignments.set(`${a.assignment_schoology_id}|${a.topic_id}`, a);
  return {
    categories: [...categories.values()],
    allTopics: [...new Map(reads.flatMap((r) => r.allTopics).map((t) => [t.id, t])).values()],
    alignmentRows: [...alignments.values()],
    observationsByTopic,
    allMaterialIds: new Set(reads.flatMap((r) => [...r.allMaterialIds])),
    materialMap: Object.assign({}, ...reads.map((r) => r.materialMap)),
    rollupRows: reads.flatMap((r) => r.rollupRows),
  };
}

export async function syncMasteryForCourse(courseId, { onProgress } = {}) {
  const log = (msg) => {
    console.log(`[masterySync] ${msg}`);
    onProgress?.({ message: msg });
  };

  const db = getDb();
  const courseRow = getCourseRow(db, courseId);
  if (!courseRow) throw new Error(`Course ${courseId} not found in DB`);

  // #178: a course of linked sections is read section by section, and written once.
  const reads = [];
  for (const sectionId of courseSectionIds(db, courseId)) {
    log(`Starting mastery sync for course ${courseRow.course_name} (section ${sectionId})`);
    const reader = await openMasteryReader(sectionId);
    log('Logged in OK');
    log(`Found building_id: ${reader.buildingId}`);
    reads.push(await readCourseMastery(reader, sectionId, log));
  }
  const { categories, alignmentRows, observationsByTopic, allMaterialIds, materialMap, rollupRows } = mergeMasteryReads(reads);

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
  const deleteScore = db.prepare(`
    DELETE FROM mastery_scores
    WHERE assignment_schoology_id = ? AND topic_id = ? AND student_uid = ?
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
        // No level (cleared in Schoology): keep no row, as syncMasteryForAssignment does.
        // An empty row counts as a level in every grading-state count.
        if (points === null) {
          deleteScore.run(assignId, topic.id, uid);
          continue;
        }
        upsertScore.run(uid, assignId, topic.id, points, pointsToLevel(points), now);
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

  // Persist Schoology rollups for this course (clears this course's rollups
  // first so a student who no longer has one doesn't linger). Per-course
  // keyed — see persistRollups + #127.
  const rollupsCount = persistRollups(db, courseId, rollupRows, now);

  log(`Done: ${categoriesCount} categories, ${topicsCount} topics, ${scoresCount} scores, ${rollupsCount} rollups, ${alignmentsCount} alignments`);
  // #52: the pages show "mastery as of" this, and refresh on load when it is old.
  db.prepare('UPDATE courses SET mastery_synced_at = ? WHERE id = ?').run(new Date().toISOString(), Number(courseId));
  return { categoriesCount, topicsCount, scoresCount, rollupsCount, alignmentsCount, materialsCount: allMaterialIds.size };

}

// An outcome_override as Prism stores it (mastery_rollups.override_value): its grade_scaled_rounded as a
// number, or null for none (Schoology answers a cleared override as null, or as an object of nulls,
// verified 2026-10-19). An IE override is 0, not none: the sync's earlier reading (`Number(...) || null`)
// stored an IE override as none (#188).
export function overrideValueOf(ov) {
  if (ov == null) return null;
  const v = typeof ov === 'object' ? (ov.grade_scaled_rounded ?? ov.grade_percentage ?? ov.value) : ov;
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export class MasteryOverrideError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code; // NOT_WRITABLE | CHANGED | MISMATCH
    Object.assign(this, extra);
  }
}

// Schoology's rollup and override now for one (student, objective) in one section:
// { rollup, override } (numbers, null for none).
async function readOneRollup(client, sectionId, studentUid, objectiveId) {
  const data = await client.postJson(`${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/outcomes/objectives`, {
    building_id: Number(client.buildingId), section_id: Number(sectionId),
    student_uids: String(studentUid), ids: String(objectiveId),
  });
  const row = (data?.data || []).find((r) => String(r.objective_id) === String(objectiveId));
  const so = (row?.student_outcomes || []).find((s) => String(s.student_uid) === String(studentUid));
  const rounded = so?.outcome?.grade_scaled_rounded;
  return { rollup: rounded != null ? Number(rounded) : null, override: overrideValueOf(so?.outcome_override) };
}

/**
 * The override with the write-back safety pattern (#188, as quizWriteback.js): refuse a course Prism does
 * not write to (archived, excluded; a linked set is refused by the write client), re-read Schoology's
 * rollup and override, refuse when either differs from what Prism holds (and store what Schoology has, so
 * the teacher sees it), write, read back, and refuse a read-back that does not show the new override.
 * Every read Prism makes is stored in mastery_rollups. A write that is already in place is not sent.
 * → { override, rollup, unchanged }. Throws MasteryOverrideError, or the client's own errors.
 */
export async function overrideMasteryLevel(db, { courseId, studentUid, objectiveId, gradeScaled }) {
  const course = db.prepare('SELECT id, schoology_section_id, archived, excluded FROM courses WHERE id = ?').get(courseId);
  if (!course) throw new MasteryOverrideError('NOT_FOUND', 'Course not found');
  if (course.archived || course.excluded) {
    throw new MasteryOverrideError('NOT_WRITABLE', 'Prism does not write to Schoology for an archived course. Make this change in Schoology.');
  }
  const sectionId = course.schoology_section_id;
  const isCategory = db.prepare('SELECT 1 FROM reporting_categories WHERE id = ?').get(String(objectiveId)) ? 1 : 0;
  const key = [String(studentUid), String(objectiveId), Number(courseId)];
  const stored = db.prepare('SELECT grade_scaled_rounded, override_value FROM mastery_rollups WHERE student_uid = ? AND objective_id = ? AND course_id = ?').get(...key);
  // A category row even when Schoology had no level for it yet: the Roster's Mastery view reads category
  // rows only (#160). MAX repairs a row an earlier mirror stored as a topic row.
  const store = ({ rollup, override }) => db.prepare(`
    INSERT INTO mastery_rollups (student_uid, objective_id, course_id, is_category, grade_percentage, grade_scaled_rounded, override_value, synced_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
    ON CONFLICT(student_uid, objective_id, course_id) DO UPDATE SET
      is_category = MAX(mastery_rollups.is_category, excluded.is_category),
      grade_scaled_rounded = excluded.grade_scaled_rounded,
      override_value = excluded.override_value,
      synced_at = excluded.synced_at
  `).run(...key, isCategory, rollup, override, new Date().toISOString());
  const levelText = (v) => (v == null ? 'none' : pointsToLevel(v) ?? String(v));

  const client = await openMasteryReader(sectionId, 'write');
  const before = await readOneRollup(client, sectionId, studentUid, objectiveId);
  const held = { rollup: stored?.grade_scaled_rounded ?? null, override: stored?.override_value ?? null };
  if (before.rollup !== held.rollup || before.override !== held.override) {
    store(before);
    throw new MasteryOverrideError('CHANGED',
      `Schoology's level changed since Prism last read it (now ${levelText(before.override ?? before.rollup)}${before.override != null ? ', an override' : ''}). Nothing was written: look at it again before overriding.`,
      { schoology: before });
  }
  const want = gradeScaled == null ? null : Number(gradeScaled);
  if (before.override === want) return { ...before, unchanged: true };

  await writeMasteryOverride({ sectionId, objectiveId, studentUid, gradeScaled, client });
  const after = await readOneRollup(client, sectionId, studentUid, objectiveId);
  store(after);
  if (after.override !== want) {
    throw new MasteryOverrideError('MISMATCH',
      `Schoology answered the override, but reading it back shows ${levelText(after.override)} instead of ${levelText(want)}. Check it in Schoology.`,
      { schoology: after });
  }
  return { ...after, unchanged: false };
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
  gradingScaleId = schoologyScaleId(),
  gradingPeriodId = 0,
  client: open = null, // an open write client (overrideMasteryLevel's), else one is opened here
}) {
  const client = open ?? await openMasteryReader(sectionId, 'write');
  const url = `${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/nodes/${objectiveId}/outcome-override`;
  const body = {
    building_id: Number(buildingId || client.buildingId),
    section_id: Number(sectionId),
    grading_period_id: Number(gradingPeriodId) || 0,
    student_uid: Number(studentUid),
    grade_scaled: gradeScaled,     // string or null
    grading_scale_id: Number(gradingScaleId),
  };
  return client.postJson(url, body);
}

/**
 * Sync mastery scores from Schoology for a single assignment. Faster than a
 * full course sync: fetches observations only for topics aligned to this
 * assignment, then upserts mastery_scores filtered to this assignment.
 *
 * Used by the assessment page's Sync Assignment button (#58) and its background refresh (#52), so
 * teachers pick up edits made directly in Schoology's gradebook.
 */
export async function syncMasteryForAssignment(courseId, assignmentId) {
  const db = getDb();
  const courseRow = getCourseRow(db, courseId);
  if (!courseRow) throw new Error(`Course ${courseId} not found`);
  // #178: every section of a course of linked sections (each has its own students).
  const sectionIds = courseSectionIds(db, courseId);

  const topicRows = db.prepare(`
    SELECT topic_id FROM mastery_alignments
    WHERE assignment_schoology_id = ? AND course_id = ?
  `).all(String(assignmentId), Number(courseId));
  if (topicRows.length === 0) {
    return { topicsCount: 0, scoresCount: 0, note: 'No aligned topics in DB: run a full mastery sync first.' };
  }
  const topicIds = topicRows.map(r => r.topic_id);

  const readers = [];
  for (const sectionId of sectionIds) readers.push({ sectionId, reader: await openMasteryReader(sectionId) });

  const upsertScore = db.prepare(`
    INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade, synced_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(student_uid, assignment_schoology_id, topic_id) DO UPDATE SET
      points = excluded.points,
      grade = excluded.grade,
      synced_at = excluded.synced_at
  `);
  const deleteScore = db.prepare(`
    DELETE FROM mastery_scores
    WHERE assignment_schoology_id = ? AND topic_id = ? AND student_uid = ?
  `);

  const now = new Date().toISOString();
  let scoresCount = 0;

  for (const topicId of topicIds) {
    const observations = [];
    for (const { sectionId, reader } of readers) {
      const url = `${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/material-observations/search?building_id=${reader.buildingId}&objective_id=${topicId}&section_id=${sectionId}`;
      observations.push(...((await reader.getJson(url)).data || []));
    }

    const seenUids = new Set();
    for (const obs of observations) {
      const obsAssignment = String(obs.gradeable_material?.material_id || '');
      if (obsAssignment !== String(assignmentId)) continue;
      const uid = String(obs.student_uid);
      const points = obs.points ?? null;
      const grade = points !== null ? pointsToLevel(points) : null;
      if (points === null) {
        deleteScore.run(String(assignmentId), topicId, uid);
      } else {
        upsertScore.run(uid, String(assignmentId), topicId, points, grade, now);
        scoresCount++;
      }
      seenUids.add(uid);
    }

    // Any local row for this (assignment, topic) whose student is no longer
    // in Schoology's response means the score was cleared in Schoology.
    const existing = db.prepare(`
      SELECT student_uid FROM mastery_scores
      WHERE assignment_schoology_id = ? AND topic_id = ?
    `).all(String(assignmentId), topicId);
    for (const row of existing) {
      if (!seenUids.has(row.student_uid)) {
        deleteScore.run(String(assignmentId), topicId, row.student_uid);
      }
    }
  }

  // Also pull grade comments + comment_status + exception + score from the
  // public grades endpoint for this assignment. Mastery observations alone
  // don't carry comments, and the assessment-page Refresh button is the
  // only sync the user runs from there — without this, comments edited in
  // Schoology never make it back into Prism.
  let commentsCount = 0;
  try {
    // One task's grades (?assignment_id=, verified 2026-10-19), not the whole section's (#168).
    const forAssignment = [];
    for (const sectionId of sectionIds) {
      forAssignment.push(...(await getAssignmentGrades(sectionId, String(assignmentId)))
        .filter(g => String(g.assignment_id) === String(assignmentId)));
    }
    const updateGrade = db.prepare(`
      UPDATE grades
      SET score = ?, grade_comment = ?, comment_status = ?, exception = ?
      WHERE student_id = (
        SELECT s.id FROM students s
        JOIN enrolments e ON e.student_id = s.id
        WHERE e.schoology_enrolment_id = ?
      )
      AND assignment_id = (
        SELECT id FROM assignments WHERE schoology_assignment_id = ?
      )
    `);
    for (const g of forAssignment) {
      const info = updateGrade.run(
        g.grade ?? null,
        g.comment || null,
        g.comment_status ?? null,
        g.exception ?? 0,
        String(g.enrollment_id),
        String(assignmentId),
      );
      if (info.changes > 0) commentsCount++;
    }
  } catch (err) {
    console.warn(`[mastery sync] grade-comment pull failed for assignment ${assignmentId}: ${err.message}`);
  }

  // #52: the assessment page shows "mastery as of" this, and refreshes on load when it is old.
  db.prepare('UPDATE assignments SET mastery_synced_at = ? WHERE schoology_assignment_id = ? AND course_id = ?')
    .run(new Date().toISOString(), String(assignmentId), Number(courseId));
  return { topicsCount: topicIds.length, scoresCount, commentsCount };
}

/**
 * Write mastery scores for one student+assignment back to Schoology.
 *
 * @param {object} params
 * @param {string} params.courseId — Prism internal course ID
 * @param {string} params.sectionId — Schoology section ID
 * @param {string|number} params.enrollmentId — Schoology enrollment ID (schoology_enrolment_id)
 * @param {string|number} params.assignmentId — Schoology assignment ID (materialId)
 * @param {object} params.gradeInfo — { [topicUUID]: { grade: "75.00", gradingScaleId } } (gradingScaleId = the configured Schoology scale id; see server/lib/proficiencyScale.js)
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
  const client = await openMasteryReader(sectionId, 'write');
  return postObservation(client, {
    sectionId, enrollmentId, assignmentId, gradeInfo, gradingPeriodId, gradingCategoryId,
  });
}

/**
 * Batched variant of {@link writeMasteryScores}: writes every entry's
 * observation set through one client, so the mastery page is read once for the
 * CSRF pair for the whole batch (the /observations endpoint is still posted
 * per-enrollment; it is not known to accept multiple enrollments at once).
 * Plain HTTP since #141: the browser launch was the dominant cost of the
 * assessment-page "Send all".
 *
 * Fail-fast / all-or-nothing: the first failed observation throws, and the
 * caller treats the whole batch as failed so
 * nothing downstream (comments, local mirror) runs. A retry is safe — the
 * endpoint replaces the observation set for an enrollment.
 *
 * @param {object} params
 * @param {string} params.sectionId — Schoology section ID
 * @param {Array<{enrollmentId, assignmentId, gradeInfo, gradingPeriodId, gradingCategoryId}>} params.entries
 */
export async function writeMasteryScoresBatch({ sectionId, entries }) {
  const client = await openMasteryReader(sectionId, 'write');
  const results = [];
  for (const e of entries) {
    const result = await postObservation(client, {
      sectionId,
      enrollmentId: e.enrollmentId,
      assignmentId: e.assignmentId,
      gradeInfo: e.gradeInfo,
      gradingPeriodId: e.gradingPeriodId,
      gradingCategoryId: e.gradingCategoryId,
    });
    results.push({ enrollmentId: e.enrollmentId, result });
  }
  return results;
}

/**
 * POST one enrollment's observation set to the district-mastery endpoint through
 * a client (openMasteryReader). The /observations call replaces the whole
 * observation set for this enrollment+material, so callers must pass gradeInfo
 * for every aligned topic. Throws on a non-OK response.
 */
async function postObservation(client, { sectionId, enrollmentId, assignmentId, gradeInfo, gradingPeriodId, gradingCategoryId }) {
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

  const topicCount = Object.keys(gradeInfo).length;
  console.log(`[mastery write] enrollment=${enrollmentId} assignment=${assignmentId} topics=${topicCount}`);
  console.log(`[mastery write] gradeInfo=${JSON.stringify(gradeInfo)}`);

  const result = await client.postJson(url, payload);
  console.log(`[mastery write] answer=${JSON.stringify(result).slice(0, 500)}`);
  return result;
}

/**
 * Persist Schoology's per-(student, objective) rollups for ONE course.
 *
 * Rollups are keyed per course (#127): objective UUIDs are district-global
 * (shared across the teacher's sections), so a student enrolled in several of
 * the teacher's courses has a DISTINCT rollup per course for the same objective.
 * Clears this course's rollups first — so a student who no longer has one
 * (dropped the class, or had the score cleared in Schoology) doesn't linger —
 * then upserts the fresh set. The delete+insert run in a single transaction so
 * a concurrent read never sees a half-synced (empty) rollup set for the course.
 * Other courses' rollups are never touched.
 *
 * @returns {number} rollups written
 */
export function persistRollups(db, courseId, rollupRows, now) {
  const cid = Number(courseId);
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM mastery_rollups WHERE course_id = ?`).run(cid);
    const upsert = db.prepare(`
      INSERT INTO mastery_rollups (student_uid, objective_id, course_id, is_category, grade_percentage, grade_scaled_rounded, override_value, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(student_uid, objective_id, course_id) DO UPDATE SET
        is_category = excluded.is_category,
        grade_percentage = excluded.grade_percentage,
        grade_scaled_rounded = excluded.grade_scaled_rounded,
        override_value = excluded.override_value,
        synced_at = excluded.synced_at
    `);
    let count = 0;
    for (const r of rollupRows) {
      upsert.run(
        r.student_uid, r.objective_id, cid, r.is_category,
        r.grade_percentage, r.grade_scaled_rounded, r.override_value, now
      );
      count++;
    }
    return count;
  });
  return tx();
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
      WHERE a.course_id = ? AND a.published = 1 AND a.removed_at IS NULL
    )
    ORDER BY mt.external_id
  `).all(courseId);

  const categoryIds = [...new Set(topics.map(t => t.category_id))];
  const categories = categoryIds.length > 0 ? db.prepare(`
    SELECT * FROM reporting_categories WHERE id IN (${categoryIds.map(() => '?').join(',')})
    ORDER BY external_id
  `).all(...categoryIds) : [];

  // Exclude scores for (student, assignment) pairs where the assignment is
  // individually targeted at others — #54. Keeps the class-roster category
  // averages consistent with the student-page mastery summary, which applies
  // the same filter.
  const scores = topics.length > 0 ? db.prepare(`
    SELECT ms.*, s.first_name, s.last_name, s.preferred_name, s.schoology_uid
    FROM mastery_scores ms
    JOIN students s ON s.schoology_uid = ms.student_uid
    JOIN assignments a ON a.schoology_assignment_id = ms.assignment_schoology_id
    LEFT JOIN folders f ON f.schoology_folder_id = a.folder_id AND f.course_id = a.course_id
    LEFT JOIN folders fp ON fp.schoology_folder_id = f.parent_id AND fp.course_id = f.course_id AND f.parent_id != '0'
    WHERE a.course_id = ? AND a.published = 1 AND a.removed_at IS NULL
      AND (
        a.num_assignees IS NULL OR a.num_assignees = 0
        OR EXISTS (
          SELECT 1 FROM assignment_assignees aa
          WHERE aa.assignment_id = a.id AND aa.schoology_uid = ms.student_uid
        )
      )
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
 * One student's topic levels on one assignment, read fresh from Schoology (#40). Clearing Missing
 * blanks the levels Missing kept, so the saved copy must hold Schoology's own levels, not a local
 * read that may be stale. One page GET (the CSRF pair and building id), then ONE batched
 * material-observations/search POST for the task's topics (the verified #104 shape, keyed by
 * objective_id, normalised by normalizeObservation), filtered to the student and the task.
 * observations/search (getRubricScoresForStudent) is not used: it keys scores by alignment_id,
 * which needs alignments/search to map to a topic.
 * → { [topicId]: level } for every scored topic. Throws when the read fails.
 */
export async function readPairLevels({ sectionId, studentUid, assignmentId, topicIds }) {
  const ids = (topicIds || []).map(String);
  if (ids.length === 0) return {};
  const reader = await openMasteryReader(sectionId);
  const resp = await reader.postJson(`${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/material-observations/search`, {
    building_id: Number(reader.buildingId),
    section_id: Number(sectionId),
    objective_ids: ids.join(','),
  });
  const byTopic = groupObservationsByTopic((resp.data || []).map(normalizeObservation), ids);
  const levels = {};
  for (const id of ids) {
    for (const obs of byTopic[id] || []) {
      if (String(obs.student_uid) !== String(studentUid)) continue;
      if (String(obs.gradeable_material?.material_id ?? '') !== String(assignmentId)) continue;
      if (obs.points != null) levels[id] = pointsToLevel(obs.points);
    }
  }
  return levels;
}

/**
 * Get current per-topic mastery scores for one student on one assignment.
 * Used to pre-populate the grading panel before writing.
 *
 * Endpoint: GET /course/{sectionId}/district_mastery/api/observations/search
 *   ?student_uids={uid}&section_id={sectionId}&material_type=ASSIGNMENT&material_id={assignmentId}
 *
 * Returns an array of { alignment_id, points, grade_percentage, ... }. alignment_id is the
 * alignment's own id, NOT the topic UUID (checked live 2026-10-19): alignments/search maps
 * it to the topic (its `id` → `objective.id`).
 */
// One GET over plain HTTP with the saved session's cookies (#141): the browser
// path loaded the mastery page first, which this GET does not need.
export async function getRubricScoresForStudent({ sectionId, studentUid, assignmentId }) {
  const url =
    `${SCHOOLOGY_BASE}/course/${sectionId}/district_mastery/api/observations/search` +
    `?student_uids=${studentUid}&section_id=${sectionId}&material_type=ASSIGNMENT&material_id=${assignmentId}`;
  let web;
  try { web = masteryDeps.web(); } catch { web = { jar: null }; }
  if (!web?.jar) throw new Error('No saved Schoology session: run `npm run mastery:login`.');
  let r;
  try {
    r = await getJson(web.jar, url, { fetchImpl: web.fetchImpl });
  } catch (err) {
    if (err instanceof WebSessionError && err.code === 'SESSION_EXPIRED') {
      noteSessionLive('expired', 'A mastery read was sent to the login page');
      throw new Error('Not logged in to Schoology: the mastery session has expired. Log in and retry.');
    }
    throw err;
  }
  if (r.status < 200 || r.status > 299) throw new Error(`HTTP ${r.status} for ${url}`);
  if (r.json == null) throw new Error(`No JSON in the answer for ${url}`);
  return r.json.data || [];
}

