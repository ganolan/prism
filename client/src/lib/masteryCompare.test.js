// The Roster tab's Mastery mode (#160): Prism's levels beside Schoology's.
import { describe, it, expect } from 'vitest';
import { categoryTracks, studentMastery, classMastery, nextSort, sortedBy, missingCategories } from './masteryCompare.js';
import { makeScaleHelpers } from './masteryLevels.js';

const scale = makeScaleHelpers([
  { code: 'ED', label: 'Exhibiting Depth', points: 100, gradeScaled: '87.50' },
  { code: 'EX', label: 'Exhibiting', points: 75, gradeScaled: '62.50' },
  { code: 'D', label: 'Developing', points: 50, gradeScaled: '37.50' },
  { code: 'EM', label: 'Emerging', points: 25, gradeScaled: '12.50' },
  { code: 'IE', label: 'Insufficient Evidence', points: 0, gradeScaled: '0.00' },
]);

const align = (topic_id, topic_external_id, topic_title, category_id, category_external_id, category_title) => ({
  assignment_schoology_id: 'a1', topic_id, topic_external_id, topic_title, category_id, category_external_id, category_title,
});
const score = (student_uid, topic_id, points, assignment_schoology_id = 'a1') => ({ student_uid, topic_id, points, assignment_schoology_id });

const MASTERY = {
  categories: [
    { id: 'c2', external_id: 'APCS.2', title: 'AP CS: Computational Thinking Practices', weight: 50 },
    { id: 'c1', external_id: 'APCS.1', title: 'AP CS: Content Knowledge', weight: 50 },
  ],
  // Only topics with scores; 2.2 Algorithms is aligned but not assessed yet.
  topics: [
    { id: 't11', category_id: 'c1', external_id: 'APCS.1.1', title: 'General Computer Science Knowledge' },
    { id: 't21', category_id: 'c2', external_id: 'APCS.2.1', title: 'Responsible Solution Design' },
    { id: 't23', category_id: 'c2', external_id: 'APCS.2.3', title: 'Abstraction' },
  ],
  alignments: [
    align('t11', 'APCS.1.1', 'General Computer Science Knowledge', 'c1', 'APCS.1', 'AP CS: Content Knowledge'),
    align('t21', 'APCS.2.1', 'Responsible Solution Design', 'c2', 'APCS.2', 'AP CS: Computational Thinking Practices'),
    align('t22', 'APCS.2.2', 'Algorithms', 'c2', 'APCS.2', 'AP CS: Computational Thinking Practices'),
    align('t23', 'APCS.2.3', 'Abstraction', 'c2', 'APCS.2', 'AP CS: Computational Thinking Practices'),
  ],
  scores: [
    score('u1', 't11', 75),
    score('u1', 't21', 100),
    score('u1', 't23', 50, 'a1'), score('u1', 't23', 50, 'a2'), score('u1', 't23', 50, 'a3'),
    score('u2', 't11', 100),
    score('u2', 't21', 50),
    score('u2', 't23', null), // a score row with no points counts for nothing
  ],
  rollups: [
    { student_uid: 'u1', objective_id: 'c1', is_category: 1, grade_percentage: 75, grade_scaled_rounded: 62.5, override_value: null },
    { student_uid: 'u1', objective_id: 'c2', is_category: 1, grade_percentage: 90, grade_scaled_rounded: 87.5, override_value: 37.5 },
    { student_uid: 'u1', objective_id: 't23', is_category: 0, grade_percentage: 50, grade_scaled_rounded: 37.5, override_value: null },
    { student_uid: 'u2', objective_id: 'c1', is_category: 1, grade_percentage: 100, grade_scaled_rounded: 87.5, override_value: null },
    { student_uid: 'u2', objective_id: 'c2', is_category: 1, grade_percentage: 50, grade_scaled_rounded: 37.5, override_value: null },
  ],
};

describe('categoryTracks', () => {
  it('lists each category in order with its number and its name without the course prefix', () => {
    const tracks = categoryTracks(MASTERY);
    expect(tracks.map((t) => [t.id, t.number, t.name])).toEqual([
      ['c1', '1', 'Content Knowledge'],
      ['c2', '2', 'Computational Thinking Practices'],
    ]);
  });

  it('lists a topic with no scores, from the alignments, in code order', () => {
    const c2 = categoryTracks(MASTERY).find((t) => t.id === 'c2');
    expect(c2.topics).toEqual([
      { id: 't21', code: '2.1', title: 'Responsible Solution Design' },
      { id: 't22', code: '2.2', title: 'Algorithms' },
      { id: 't23', code: '2.3', title: 'Abstraction' },
    ]);
  });

  it('numbers a category with no dotted external id by its order, and keeps a title with no prefix', () => {
    const tracks = categoryTracks({
      categories: [{ id: 'x', external_id: null, title: 'Creating' }, { id: 'y', external_id: 'RC', title: 'Responding' }],
      topics: [{ id: 'tx', category_id: 'x', external_id: null, title: 'Ideas' }],
      alignments: [],
    });
    expect(tracks.map((t) => [t.number, t.name])).toEqual([['1', 'Creating'], ['2', 'Responding']]);
    expect(tracks[0].topics).toEqual([{ id: 'tx', code: '1.1', title: 'Ideas' }]);
  });

  it('gives each category a short label from its name (#192), distinct within the course', () => {
    expect(categoryTracks(MASTERY).map((t) => t.abbr)).toEqual(['CK', 'CTP']);
    const clash = categoryTracks({
      categories: [{ id: 'a', external_id: 'X.1', title: 'X: Content Knowledge' }, { id: 'b', external_id: 'X.2', title: 'X: Computing Knowledge' }],
      topics: [], alignments: [],
    });
    expect(clash.map((t) => t.abbr)).toEqual(['ConK', 'ComK']);
  });

  it('missingCategories names the categories with no level on a side, in order', () => {
    const tracks = categoryTracks(MASTERY);
    const cell = (prism, schoology) => ({ prism: { level: prism }, schoology: schoology ? { level: schoology } : null });
    expect(missingCategories(tracks, { c1: cell(null, 'EX'), c2: cell(null, null) })).toEqual(['Content Knowledge', 'Computational Thinking Practices']);
    expect(missingCategories(tracks, { c1: cell(null, 'EX'), c2: cell('D', null) }, 'schoology')).toEqual(['Computational Thinking Practices']);
    expect(missingCategories(tracks, { c1: cell('EX', 'EX'), c2: cell('D', 'D') })).toEqual([]);
  });

  it('is empty with no mastery data', () => {
    expect(categoryTracks(null)).toEqual([]);
    expect(categoryTracks({ categories: [], topics: [], scores: [], rollups: [], alignments: [] })).toEqual([]);
  });
});

describe('studentMastery', () => {
  it("averages each topic's scores, and a topic not assessed yet is null", () => {
    const m = studentMastery(MASTERY, 'u1', scale);
    expect(m.topics.t11).toEqual({ pct: 75, level: 'EX' });
    expect(m.topics.t23).toEqual({ pct: 50, level: 'D' });
    expect(m.topics.t22).toBeNull();
  });

  it("Prism's category value is the flat mean of every score in the category, not a mean of topic means", () => {
    // 2.1 [100] and 2.3 [50, 50, 50]: (100 + 150) / 4 = 62.5, where the topic means would give 75.
    expect(studentMastery(MASTERY, 'u1', scale).categories.c2.prism).toEqual({ pct: 62.5, level: 'EX' });
  });

  it("Schoology's level is the category rollup: the override when set, else grade_scaled_rounded", () => {
    const m = studentMastery(MASTERY, 'u1', scale);
    expect(m.categories.c1.schoology).toEqual({ level: 'EX', isOverride: false });
    expect(m.categories.c2.schoology).toEqual({ level: 'D', isOverride: true });
  });

  it('differs holds when the levels differ', () => {
    const m = studentMastery(MASTERY, 'u1', scale);
    expect(m.categories.c1.differs).toBe(false);
    expect(m.categories.c2.differs).toBe(true);
  });

  it('the grades differ when the category levels give different letters', () => {
    // Prism EX + EX = B+; Schoology EX + D = B.
    expect(studentMastery(MASTERY, 'u1', scale).grade).toEqual({ prism: 'B+', schoology: 'B', differs: true });
    // u2: Prism ED (100) + D (50) = B+; Schoology ED + D = B+.
    expect(studentMastery(MASTERY, 'u2', scale).grade).toEqual({ prism: 'B+', schoology: 'B+', differs: false });
  });

  it('a student with no scores and no rollups has no levels and no grade, and nothing differs', () => {
    const m = studentMastery(MASTERY, 'nobody', scale);
    expect(m.categories.c1).toEqual({ prism: { pct: null, level: null }, schoology: null, differs: false });
    expect(m.grade).toEqual({ prism: null, schoology: null, differs: false });
  });

  it('a Prism level with no Schoology rollup differs (Schoology has nothing to show)', () => {
    const noRollups = { ...MASTERY, rollups: [] };
    expect(studentMastery(noRollups, 'u1', scale).categories.c1).toMatchObject({ schoology: null, differs: true });
  });
});

describe('classMastery', () => {
  it("is the mean of the students' values, for the students given only", () => {
    const c = classMastery(MASTERY, ['u1', 'u2'], scale);
    expect(c.topics.t11).toEqual({ pct: 87.5, level: 'ED' });
    expect(c.topics.t22).toBeNull();
    // u1 62.5 and u2 50 (its null score counts for nothing).
    expect(c.categories.c2.prism).toEqual({ pct: 56.25, level: 'D' });
    expect(c.categories.c2.schoology).toBeNull();
    expect(c.grade.prism).toBe('B+'); // ED (87.5) + D
    expect(classMastery(MASTERY, ['u2'], scale).topics.t11).toEqual({ pct: 100, level: 'ED' });
  });
});

describe('nextSort', () => {
  it('cycles highest first, lowest first, then off; a new key starts highest first', () => {
    const a = nextSort(null, 't23');
    expect(a).toEqual({ key: 't23', dir: 'desc' });
    const b = nextSort(a, 't23');
    expect(b).toEqual({ key: 't23', dir: 'asc' });
    expect(nextSort(b, 't23')).toBeNull();
    expect(nextSort(b, 'prism')).toEqual({ key: 'prism', dir: 'desc' });
  });
});

describe('sortedBy', () => {
  const list = [{ n: 'a', v: 50 }, { n: 'b', v: null }, { n: 'c', v: 100 }, { n: 'd', v: 50 }];
  it('sorts by the value, keeping the given order on ties, with no value last either way', () => {
    expect(sortedBy(list, { dir: 'desc' }, (x) => x.v).map((x) => x.n)).toEqual(['c', 'a', 'd', 'b']);
    expect(sortedBy(list, { dir: 'asc' }, (x) => x.v).map((x) => x.n)).toEqual(['a', 'd', 'c', 'b']);
    expect(sortedBy(list, null, (x) => x.v)).toBe(list);
  });
});
