import { computeLetterGrade } from './masteryLevels.js';
import { categoryAbbreviations } from './categoryAbbr.js';

// The Roster tab's Mastery mode (#160; spec "Mastery"): Prism's reporting-category levels and grade
// beside Schoology's, from one getMasteryForCourse answer
// ({ categories, topics, scores, rollups, alignments }).
//  - A topic's value is the mean of the student's scores on it (mastery_scores points).
//  - Prism's category value is the flat mean of every score the student has in the category's topics
//    (all the points together, not a mean of topic means): the value the old roster called Computed,
//    and the one Graham takes as correct (25 Oct 2026).
//  - Schoology's category level is its category rollup: override_value when set, else
//    grade_scaled_rounded. It is what students and report cards see.
//  - Grades: computeLetterGrade on each side's levels (null while any category has no level).
// Levels come from the proficiency scale (useProficiencyScale / makeScaleHelpers: pointsToLevel).

const byCode = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true });
const mean = (xs) => (xs?.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const levelOf = (pct, scale) => ({ pct, level: pct == null ? null : scale.pointsToLevel(pct) });

// "APCS.2" → "2"; with no dot (or no id) the category's place in the list.
function categoryNumber(externalId, index) {
  const s = String(externalId ?? '');
  const dot = s.lastIndexOf('.');
  return dot >= 0 && dot < s.length - 1 ? s.slice(dot + 1) : String(index + 1);
}

// "AP CS: Content Knowledge" → "Content Knowledge".
function categoryName(title) {
  const m = /^[^:]*:\s+(.+)$/.exec(String(title ?? ''));
  return m ? m[1] : String(title ?? '');
}

// "APCS.2.3" → "2.3"; an id with no dot as it is; no id: the category number and the topic's place.
function topicCode(externalId, number, index) {
  const s = String(externalId ?? '');
  if (!s) return `${number}.${index + 1}`;
  const dot = s.indexOf('.');
  return dot >= 0 && dot < s.length - 1 ? s.slice(dot + 1) : s;
}

// → [{ id, number, abbr, name, title, topics: [{ id, code, title }] }], in external id order. Topics come
// from the alignments as well as the scored topics, so a topic not assessed yet has its place. `abbr`
// is the short label the roster shows instead of the number (lib/categoryAbbr.js, #192).
export function categoryTracks(mastery) {
  if (!mastery) return [];
  const cats = new Map();
  for (const c of mastery.categories || []) cats.set(String(c.id), { id: c.id, externalId: c.external_id, title: c.title });
  for (const a of mastery.alignments || []) {
    if (a.category_id != null && !cats.has(String(a.category_id))) {
      cats.set(String(a.category_id), { id: a.category_id, externalId: a.category_external_id, title: a.category_title });
    }
  }
  const topics = new Map();
  for (const t of mastery.topics || []) topics.set(String(t.id), { id: t.id, categoryId: t.category_id, externalId: t.external_id, title: t.title });
  for (const a of mastery.alignments || []) {
    if (a.topic_id != null && !topics.has(String(a.topic_id))) {
      topics.set(String(a.topic_id), { id: a.topic_id, categoryId: a.category_id, externalId: a.topic_external_id, title: a.topic_title });
    }
  }
  const tracks = [...cats.values()]
    .sort((a, b) => byCode(a.externalId, b.externalId) || byCode(a.title, b.title))
    .map((c, i) => {
      const number = categoryNumber(c.externalId, i);
      const own = [...topics.values()].filter((t) => String(t.categoryId) === String(c.id))
        .sort((a, b) => byCode(a.externalId, b.externalId) || byCode(a.title, b.title));
      return {
        id: c.id, number, name: categoryName(c.title), title: c.title,
        topics: own.map((t, k) => ({ id: t.id, code: topicCode(t.externalId, number, k), title: t.title })),
      };
    });
  const abbrs = categoryAbbreviations(tracks.map((t) => t.name), tracks.map((t) => t.number));
  return tracks.map((t, i) => ({ ...t, abbr: abbrs[i] }));
}

// The categories a grade is waiting for: those with no level on the given side ('prism' or
// 'schoology') → their names, in track order. Empty when the grade has every level it needs.
export function missingCategories(tracks, categories, side = 'prism') {
  return tracks.filter((tr) => {
    const cell = categories[tr.id];
    return (side === 'prism' ? cell?.prism?.level : cell?.schoology?.level) == null;
  }).map((tr) => tr.name);
}

// One index per mastery answer: the tracks, each student's points by topic and by category, and
// each student's category rollups.
const indexes = new WeakMap();
function indexOf(mastery) {
  let ix = indexes.get(mastery);
  if (ix) return ix;
  const tracks = categoryTracks(mastery);
  const categoryOfTopic = {};
  for (const tr of tracks) for (const t of tr.topics) categoryOfTopic[String(t.id)] = String(tr.id);
  const points = {}; // uid → { topics: { id: [points] }, categories: { id: [points] } }
  for (const s of mastery.scores || []) {
    if (s.points == null) continue;
    const tid = String(s.topic_id);
    const cid = categoryOfTopic[tid];
    if (!cid) continue;
    const mine = (points[String(s.student_uid)] ??= { topics: {}, categories: {} });
    (mine.topics[tid] ??= []).push(Number(s.points));
    (mine.categories[cid] ??= []).push(Number(s.points));
  }
  const rollups = {}; // uid → category id → rollup row
  for (const r of mastery.rollups || []) {
    if (!r.is_category) continue;
    (rollups[String(r.student_uid)] ??= {})[String(r.objective_id)] = r;
  }
  ix = { tracks, points, rollups };
  indexes.set(mastery, ix);
  return ix;
}

const EMPTY = {};
const differs = (prism, schoology) => prism != null && prism !== schoology;

function gradeOf(tracks, categories) {
  const prism = computeLetterGrade(tracks.map((tr) => categories[tr.id].prism.level));
  const schoology = computeLetterGrade(tracks.map((tr) => categories[tr.id].schoology?.level ?? null));
  return { prism, schoology, differs: differs(prism, schoology) };
}

// → { topics: { [topicId]: { pct, level } | null },
//     categories: { [categoryId]: { prism: { pct, level }, schoology: { level, isOverride } | null, differs } },
//     grade: { prism, schoology, differs } }
// differs: Prism has a level and Schoology's is not the same one (or Schoology has none).
export function studentMastery(mastery, studentUid, scale) {
  const { tracks, points, rollups } = indexOf(mastery || EMPTY);
  const uid = String(studentUid);
  const mine = points[uid] || { topics: {}, categories: {} };
  const topics = {};
  const categories = {};
  for (const tr of tracks) {
    for (const t of tr.topics) {
      const pct = mean(mine.topics[String(t.id)]);
      topics[t.id] = pct == null ? null : levelOf(pct, scale);
    }
    const prism = levelOf(mean(mine.categories[String(tr.id)]), scale);
    const r = rollups[uid]?.[String(tr.id)];
    const raw = r ? (r.override_value ?? r.grade_scaled_rounded) : null;
    const schoology = raw == null ? null : { level: scale.pointsToLevel(Number(raw)), isOverride: r.override_value != null };
    categories[tr.id] = { prism, schoology, differs: differs(prism.level, schoology?.level ?? null) };
  }
  return { topics, categories, grade: gradeOf(tracks, categories) };
}

// The class average row: the same shape, each value the mean of the given students' values (a student
// with no value is left out). Schoology has no class value, so it is null and nothing differs.
export function classMastery(mastery, studentUids, scale) {
  const { tracks } = indexOf(mastery || EMPTY);
  const each = studentUids.map((uid) => studentMastery(mastery, uid, scale));
  const meanOf = (pick) => mean(each.map(pick).filter((v) => v != null));
  const topics = {};
  const categories = {};
  for (const tr of tracks) {
    for (const t of tr.topics) {
      const pct = meanOf((m) => m.topics[t.id]?.pct);
      topics[t.id] = pct == null ? null : levelOf(pct, scale);
    }
    categories[tr.id] = { prism: levelOf(meanOf((m) => m.categories[tr.id].prism.pct), scale), schoology: null, differs: false };
  }
  const prism = computeLetterGrade(tracks.map((tr) => categories[tr.id].prism.level));
  return { topics, categories, grade: { prism, schoology: null, differs: false } };
}

// A column heading's sort: highest first, then lowest first, then off. Another column starts again.
export function nextSort(current, key) {
  if (!current || current.key !== key) return { key, dir: 'desc' };
  if (current.dir === 'desc') return { key, dir: 'asc' };
  return null;
}

// `list` sorted by `valueOf` in the sort's direction; ties keep the given order, and an item with no
// value goes last either way. No sort: the list itself.
export function sortedBy(list, sort, valueOf) {
  if (!sort) return list;
  const sign = sort.dir === 'asc' ? 1 : -1;
  return list.map((item, i) => ({ item, i, v: valueOf(item) }))
    .sort((a, b) => {
      if (a.v == null || b.v == null) return (a.v == null) - (b.v == null) || a.i - b.i;
      return sign * (a.v - b.v) || a.i - b.i;
    })
    .map((x) => x.item);
}
