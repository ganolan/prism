import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getMasteryForStudent } from '../services/api.js';
import OverridePopup from './OverridePopup.jsx';

// ── Proficiency level helpers ────────────────────────────────────────────────

const LEVELS = ['ED', 'EX', 'D', 'EM', 'IE'];
const LEVEL_LABELS = { ED: 'Exhibiting Depth', EX: 'Exhibiting', D: 'Developing', EM: 'Emerging', IE: 'Insufficient Evidence' };
const LEVEL_POINTS = { ED: 100, EX: 75, D: 50, EM: 25, IE: 0 };
const LEVEL_COLORS = {
  ED: { bg: '#dbeafe', text: '#1e40af', border: '#93c5fd' },
  EX: { bg: '#dcfce7', text: '#166534', border: '#86efac' },
  D:  { bg: '#fef9c3', text: '#713f12', border: '#fde047' },
  EM: { bg: '#ffedd5', text: '#9a3412', border: '#fed7aa' },
  IE: { bg: '#fee2e2', text: '#991b1b', border: '#fca5a5' },
};

// Match proficiency level order: A=ED(blue), B=EX(green), C=D(yellow),
// D=EM(orange), F=IE(red). Text tones from LEVEL_COLORS[].text; +/- variants
// step one shade lighter.
export const LETTER_GRADE_COLORS = {
  A: '#1e40af', 'A-': '#2563eb',
  'B+': '#15803d', B: '#166534', 'B-': '#166534',
  'C+': '#854d0e', C: '#713f12',
  D: '#9a3412', F: '#991b1b',
};

function pointsToLevel(points) {
  if (points == null) return null;
  if (points >= 87.5) return 'ED';
  if (points >= 62.5) return 'EX';
  if (points >= 37.5) return 'D';
  if (points >= 12.5) return 'EM';
  return 'IE';
}

function modeOf(arr) {
  if (!arr.length) return null;
  const counts = {};
  for (const v of arr) counts[v] = (counts[v] || 0) + 1;
  let best = null, bestCount = 0;
  for (const [v, c] of Object.entries(counts)) {
    if (c > bestCount) { best = Number(v); bestCount = c; }
  }
  return best;
}

function average(arr) {
  const nums = arr.filter(v => v != null);
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function sentenceCase(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

// Approximate letter grade — based on HKIS General Academic Scale.
// NOTE: this is an approximation of the full combination table.
// See the letter grade popup for the authoritative HKIS scale.
export function computeLetterGrade(categoryLevels) {
  if (!categoryLevels.length || categoryLevels.some(l => l == null)) return null;
  if (categoryLevels.includes('IE')) return 'F';

  const n = categoryLevels.length;
  const pts = categoryLevels.map(l => LEVEL_POINTS[l] || 0);
  const avg = pts.reduce((a, b) => a + b, 0) / n;

  if (n === 2) {
    const sorted = [...categoryLevels].sort().join('+');
    return ({
      'ED+ED': 'A', 'ED+EX': 'A-', 'EX+EX': 'B+', 'D+ED': 'B+',
      'D+EX': 'B', 'ED+EM': 'B', 'D+D': 'B-', 'EM+EX': 'B-',
      'D+EM': 'C+', 'EM+EM': 'C',
    })[sorted] || 'D';
  }

  // For 3–5 categories, use a scaled average approach
  const scaled = avg / 25; // 0–4
  if (scaled >= 3.75) return 'A';
  if (scaled >= 3.25) return 'A-';
  if (scaled >= 2.83) return 'B+';
  if (scaled >= 2.33) return 'B';
  if (scaled >= 2.0)  return 'B-';
  if (scaled >= 1.75) return 'C+';
  if (scaled >= 1.25) return 'C';
  if (scaled >= 1.0)  return 'D';
  return 'F';
}

// ── Letter grade scale popup ─────────────────────────────────────────────────

export function LetterGradePopup({ onClose, numCategories }) {
  const scale = [
    { grade: 'A',   bg: '#dbeafe', rows: { 2: '2ED', 3: '3ED', 4: '4ED', 5: '5ED' } },
    { grade: 'A-',  bg: '#dbeafe', rows: { 2: '1ED / 1EX', 3: '2ED / 1EX', 4: '3ED / 1EX', 5: '4ED / 1EX\n3ED / 2EX' } },
    { grade: 'B+',  bg: '#dcfce7', rows: { 2: '2EX\n1ED / 1D', 3: '1ED / 2EX\n3EX', 4: '2ED / 2EX\n1ED / 3EX\n4EX', 5: '3ED / 2EX\n2ED / 3EX\n1ED / 4EX\n5EX' } },
    { grade: 'B',   bg: '#dcfce7', rows: { 2: '1EX / 1D\n1ED / 1EM', 3: '1ED / 1EX / 1D\n2EX / 1D\n1ED / 2D', 4: '1ED / 1EX / 2D\n2EX / 2D\n3EX / 1D', 5: '1ED / 2EX / 2D\n3EX / 2D' } },
    { grade: 'B-',  bg: '#dcfce7', rows: { 2: '2D\n1EX / 1EM', 3: '1EX / 2D\n1ED / 1D / 1EM\n3D', 4: '2EX / 1D / 1EM\n1EX / 3D\n4D', 5: '2EX / 3D\n1EX / 4D\n5D' } },
    { grade: 'C+',  bg: '#fef9c3', rows: { 2: '1D / 1EM', 3: '2D / 1EM\n1EX / 2EM', 4: '3D / 1EM\n2EX / 2EM', 5: '4D / 1EM\n3D / 2EM' } },
    { grade: 'C',   bg: '#fef9c3', rows: { 2: '2EM', 3: '1D / 2EM\n3EM', 4: '2D / 2EM\n1D / 3EM\n4EM', 5: '3D / 2EM\n2D / 3EM\n1D / 4EM\n5EM' } },
    { grade: 'D',   bg: '#ffedd5', rows: { 2: '1EM / 1IE+\nor lower', 3: '2EM / 1IE+\nor lower', 4: 'any IE\n≥2EM', 5: 'any IE\n≥3EM' } },
    { grade: 'F',   bg: '#fee2e2', rows: { 2: 'any IE', 3: 'any IE', 4: 'any IE', 5: 'any IE' } },
  ];

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1rem',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--card-bg)', borderRadius: 12,
          padding: '1.5rem', maxWidth: 700, width: '100%',
          maxHeight: '85vh', overflow: 'auto',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ margin: 0 }}>HKIS Letter Grade Translation Scale</h3>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>

        <p className="text-sm text-muted" style={{ marginBottom: '0.75rem' }}>
          Based on reporting category proficiency levels. Approximate — verify against official HKIS scale.
        </p>

        {/* Proficiency boundaries */}
        <div style={{ overflowX: 'auto', marginBottom: '1rem' }}>
          <table style={{ fontSize: '0.8rem', width: '100%' }}>
            <thead>
              <tr>
                {LEVELS.map(l => (
                  <th key={l} style={{ background: LEVEL_COLORS[l].bg, color: LEVEL_COLORS[l].text, padding: '0.3rem 0.5rem', textAlign: 'center' }}>
                    {l} — {LEVEL_LABELS[l]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                {['87.5–100', '62.5–87.49', '37.5–62.49', '12.5–37.49', '0–12.49'].map((r, i) => (
                  <td key={i} style={{ textAlign: 'center', padding: '0.25rem', color: 'var(--text-muted)' }}>{r}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>

        {/* Letter grade table */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ fontSize: '0.8rem', borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th style={{ padding: '0.4rem 0.6rem', background: 'var(--bg-subtle)', textAlign: 'left' }}>Grade</th>
                {[2, 3, 4, 5].map(n => (
                  <th key={n} style={{ padding: '0.4rem 0.6rem', background: 'var(--bg-subtle)', textAlign: 'center' }}>
                    {n} Reporting Categories{numCategories === n ? ' ← this course' : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {scale.map(row => (
                <tr key={row.grade}>
                  <td style={{ padding: '0.4rem 0.6rem', fontWeight: 700, background: row.bg, color: LETTER_GRADE_COLORS[row.grade] || '#000', textAlign: 'center' }}>
                    {row.grade}
                  </td>
                  {[2, 3, 4, 5].map(n => (
                    <td key={n} style={{
                      padding: '0.4rem 0.6rem', textAlign: 'center',
                      background: numCategories === n ? `${row.bg}cc` : 'transparent',
                      color: 'var(--text)', whiteSpace: 'pre-line', verticalAlign: 'top',
                      border: '1px solid var(--border)',
                    }}>
                      {row.rows[n] || '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Cell component ───────────────────────────────────────────────────────────

function LevelCell({ grade, size = 'md', dim = false, pending = false }) {
  if (!grade && pending) return <td style={{ background: 'var(--bg-subtle)', color: 'var(--text-muted)', textAlign: 'center', padding: size === 'sm' ? '0.2rem 0.3rem' : '0.35rem 0.5rem', fontStyle: 'italic', fontSize: '0.68rem' }}>Pending</td>;
  if (!grade) return <td style={{ background: 'var(--bg-subtle)', color: 'var(--text-muted)', textAlign: 'center', padding: size === 'sm' ? '0.2rem 0.3rem' : '0.35rem 0.5rem', opacity: dim ? 0.45 : 1 }}>—</td>;
  const c = LEVEL_COLORS[grade] || {};
  return (
    <td style={{
      background: c.bg, color: c.text,
      textAlign: 'center', fontWeight: 600,
      padding: size === 'sm' ? '0.2rem 0.3rem' : '0.35rem 0.5rem',
      fontSize: size === 'sm' ? '0.7rem' : '0.78rem',
      opacity: dim ? 0.55 : 1,
    }}>
      {grade}
    </td>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export default function MasteryPerformanceSummary({ courseId, studentUid, courseName }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showGradeScale, setShowGradeScale] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [overrideTarget, setOverrideTarget] = useState(null); // { category, currentLevel, hasOverride }
  const [overrideSaving, setOverrideSaving] = useState(false);

  useEffect(() => {
    if (!courseId || !studentUid) return;
    getMasteryForStudent(courseId, studentUid)
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [courseId, studentUid]);

  if (loading) return <p className="text-sm text-muted">Loading mastery data...</p>;
  if (!data || !data.topics?.length) return null;

  const { topics, scores, alignments, rollups } = data;

  // Schoology-reported rollup lookup by objective_id (works for both
  // measurement topics and reporting categories).
  const rollupByObj = {};
  for (const r of (rollups || [])) {
    rollupByObj[r.objective_id] = r;
  }
  const rollupLevel = (objId) => {
    const r = rollupByObj[objId];
    if (!r) return null;
    const v = r.override_value != null ? r.override_value : r.grade_scaled_rounded;
    return v != null ? pointsToLevel(v) : null;
  };
  const rollupPct = (objId) => {
    const r = rollupByObj[objId];
    return r?.grade_percentage ?? null;
  };
  const rollupIsOverride = (objId) => rollupByObj[objId]?.override_value != null;

  // Build set of aligned (assignment, topic) pairs
  const alignedSet = new Set();
  if (alignments) {
    for (const a of alignments) {
      alignedSet.add(`${a.assignment_schoology_id}::${a.topic_id}`);
    }
  }

  // ── Build structure ──────────────────────────────────────────────────────

  // Group topics by category
  const categoryMap = {};
  const categoryOrder = [];
  for (const t of topics) {
    if (!categoryMap[t.category_id]) {
      categoryMap[t.category_id] = { id: t.category_id, title: t.category_title, external_id: t.category_external_id, topics: [] };
      categoryOrder.push(t.category_id);
    }
    categoryMap[t.category_id].topics.push(t);
  }
  const categories = categoryOrder.map(id => categoryMap[id]);

  // Get unique assignments from scores, preserve order
  const assignmentIds = [...new Set(scores.map(s => s.assignment_schoology_id))];
  const assignmentTitles = {};
  for (const s of scores) {
    if (s.assignment_title) assignmentTitles[s.assignment_schoology_id] = s.assignment_title;
  }

  // Score lookup: topicId → assignmentId → { points, grade }
  const scoreLookup = {};
  for (const s of scores) {
    if (!scoreLookup[s.topic_id]) scoreLookup[s.topic_id] = {};
    scoreLookup[s.topic_id][s.assignment_schoology_id] = { points: s.points, grade: s.grade };
  }

  // ── Compute aggregates ───────────────────────────────────────────────────

  // Per topic: all scores for this student
  const topicScores = {};
  for (const t of topics) {
    topicScores[t.id] = assignmentIds
      .map(aid => scoreLookup[t.id]?.[aid]?.points)
      .filter(p => p != null);
  }

  const topicAvg = {};
  const topicMode = {};
  const topicCount = {};
  for (const t of topics) {
    const vals = topicScores[t.id];
    topicAvg[t.id] = average(vals);
    topicMode[t.id] = modeOf(vals);
    topicCount[t.id] = vals.length;
  }

  // Per category: flat average/mode of ALL individual proficiency scores (not average-of-averages)
  const catFlatAvg = {};
  const catFlatMode = {};
  for (const cat of categories) {
    const allPoints = cat.topics.flatMap(t => topicScores[t.id]);
    catFlatAvg[cat.id] = average(allPoints);
    catFlatMode[cat.id] = modeOf(allPoints);
  }

  // Letter grade uses flat category averages
  const categoryLevels = categories.map(cat => pointsToLevel(catFlatAvg[cat.id]));
  const letterGrade = computeLetterGrade(categoryLevels);

  const stickyCol = {
    position: 'sticky', left: 0, zIndex: 2,
  };
  const thStyle = {
    background: 'var(--bg-subtle)', padding: '0.35rem 0.5rem',
    fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-muted)',
    textAlign: 'center', border: '1px solid var(--border)', whiteSpace: 'nowrap',
  };
  const labelCellStyle = {
    ...stickyCol,
    padding: '0.3rem 0.6rem', fontSize: '0.75rem', fontWeight: 600,
    color: 'var(--text-muted)', background: 'var(--bg-subtle)',
    border: '1px solid var(--border)', whiteSpace: 'normal', textAlign: 'right',
    minWidth: 100, maxWidth: 180,
  };

  const masteryTable = assignmentIds.length > 0 ? (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: '0.8rem', width: '100%', minWidth: 500 }}>
        <thead>
          {/* Row 1: Reporting category headers */}
          <tr>
            <th style={{ ...thStyle, ...stickyCol, textAlign: 'right', minWidth: 100, maxWidth: 180, background: 'var(--bg-subtle)' }}>Reporting Categories</th>
            {categories.map(cat => (
              <th
                key={cat.id}
                colSpan={cat.topics.length}
                style={{
                  ...thStyle, fontWeight: 700,
                  background: 'var(--accent-subtle)',
                  color: 'var(--accent)', borderBottom: '2px solid var(--accent)',
                }}
              >
                {cat.title}
              </th>
            ))}
          </tr>

          {/* Row 2: Measurement topic headers */}
          <tr>
            <th style={{ ...thStyle, ...stickyCol, textAlign: 'right', minWidth: 100, maxWidth: 180, background: 'var(--bg-subtle)' }}>Measurement Topics</th>
            {categories.flatMap(cat =>
              cat.topics.map(t => (
                <th key={t.id} style={{ ...thStyle, maxWidth: 120, minWidth: 60, whiteSpace: 'normal', lineHeight: 1.2, fontSize: '0.65rem', fontWeight: 500 }}>
                  <span title={t.title}>{t.external_id} {sentenceCase(t.title)}</span>
                </th>
              ))
            )}
          </tr>

          {/* Row 3: Times assessed */}
          <tr>
            <td style={labelCellStyle}>Times assessed</td>
            {categories.flatMap(cat =>
              cat.topics.map(t => (
                <td key={t.id} style={{
                  textAlign: 'center', color: 'var(--text-muted)',
                  padding: '0.2rem', fontSize: '0.72rem',
                  border: '1px solid var(--border)',
                }}>
                  {topicCount[t.id]}
                </td>
              ))
            )}
          </tr>
        </thead>

        <tbody>
          {/* Assessment rows */}
          {assignmentIds.map(aid => (
            <tr key={aid}>
              <td style={{
                ...stickyCol,
                padding: '0.3rem 0.6rem', border: '1px solid var(--border)',
                fontSize: '0.78rem', background: 'var(--card-bg)',
                minWidth: 100, maxWidth: 180, whiteSpace: 'normal',
              }}>
                <Link
                  to={`/course/${courseId}/assessment/${aid}`}
                  className="link"
                  style={{ fontWeight: 500 }}
                >
                  {assignmentTitles[aid] || aid}
                </Link>
              </td>
              {categories.flatMap(cat =>
                cat.topics.map(t => {
                  const sc = scoreLookup[t.id]?.[aid];
                  const isAligned = alignedSet.has(`${aid}::${t.id}`);
                  return <LevelCell key={t.id} grade={sc?.grade || null} pending={!sc && isAligned} />;
                })
              )}
            </tr>
          ))}
        </tbody>

        <tfoot>
          {/* Measurement Topic Mode */}
          <tr>
            <td style={labelCellStyle}>Measurement Topic Mode</td>
            {categories.flatMap(cat =>
              cat.topics.map(t => {
                const lvl = topicMode[t.id] != null ? pointsToLevel(topicMode[t.id]) : null;
                const c = lvl ? LEVEL_COLORS[lvl] : null;
                return (
                  <td key={t.id} style={{
                    textAlign: 'center', fontWeight: 600, fontSize: '0.75rem',
                    padding: '0.25rem',
                    background: c ? c.bg : 'var(--bg-subtle)',
                    color: c ? c.text : 'var(--text-muted)',
                    border: '1px solid var(--border)',
                  }}>
                    {lvl || '—'}
                  </td>
                );
              })
            )}
          </tr>

          {/* Reporting Category Mode (flat mode of all proficiency scores in the category) */}
          <tr>
            <td style={labelCellStyle}>Reporting Category Mode<br /><span style={{ fontWeight: 400, fontSize: '0.65rem' }}>(of all proficiencies)</span></td>
            {categories.map(cat => {
              const lvl = catFlatMode[cat.id] != null ? pointsToLevel(catFlatMode[cat.id]) : null;
              const c = lvl ? LEVEL_COLORS[lvl] : null;
              return (
                <td key={cat.id} colSpan={cat.topics.length} style={{
                  textAlign: 'center', fontWeight: 600, fontSize: '0.78rem',
                  padding: '0.25rem',
                  background: c ? c.bg : 'var(--bg-subtle)',
                  color: c ? c.text : 'var(--text-muted)',
                  border: '1px solid var(--border)',
                }}>
                  {lvl || '—'}
                </td>
              );
            })}
          </tr>

          {/* Measurement Topic Average */}
          <tr>
            <td style={labelCellStyle}>Measurement Topic Average</td>
            {categories.flatMap(cat =>
              cat.topics.map(t => {
                const lvl = pointsToLevel(topicAvg[t.id]);
                const c = lvl ? LEVEL_COLORS[lvl] : null;
                return (
                  <td key={t.id} style={{
                    textAlign: 'center', fontWeight: 600, fontSize: '0.75rem',
                    padding: '0.25rem',
                    background: c ? c.bg : 'var(--bg-subtle)',
                    color: c ? c.text : 'var(--text-muted)',
                    border: '1px solid var(--border)',
                  }}>
                    {lvl || '—'}{topicAvg[t.id] != null ? ` (${topicAvg[t.id].toFixed(0)})` : ''}
                  </td>
                );
              })
            )}
          </tr>

          {/* Reporting Category Average (flat average of all proficiency scores in the category) */}
          <tr>
            <td style={labelCellStyle}>Reporting Category Average<br /><span style={{ fontWeight: 400, fontSize: '0.65rem' }}>(of all proficiencies)</span></td>
            {categories.map(cat => {
              const avg = catFlatAvg[cat.id];
              const lvl = pointsToLevel(avg);
              const c = lvl ? LEVEL_COLORS[lvl] : null;
              return (
                <td key={cat.id} colSpan={cat.topics.length} style={{
                  textAlign: 'center', fontWeight: 700, fontSize: '0.85rem',
                  padding: '0.3rem',
                  background: c ? c.bg : 'var(--bg-subtle)',
                  color: c ? c.text : 'var(--text-muted)',
                  border: '1px solid var(--border)',
                }}>
                  {lvl || '—'}{avg != null ? ` (${avg.toFixed(1)})` : ''}
                </td>
              );
            })}
          </tr>

          {/* Schoology Reported — per Measurement Topic (official data from Schoology mastery gradebook)
              Hidden for now: re-enable by changing the condition below to `true`.
              Data still syncs into mastery_rollups and is returned by the API. */}
          {false && (
            <tr>
              <td style={{
                ...labelCellStyle,
                color: 'var(--accent)',
                background: 'var(--accent-subtle)',
                borderLeft: '3px solid var(--accent)',
              }}>
                Schoology Reported
                <br /><span style={{ fontWeight: 400, fontSize: '0.65rem' }}>per Measurement Topic</span>
              </td>
              {categories.flatMap(cat =>
                cat.topics.map(t => {
                  const lvl = rollupLevel(t.id);
                  const pct = rollupPct(t.id);
                  const override = rollupIsOverride(t.id);
                  const c = lvl ? LEVEL_COLORS[lvl] : null;
                  return (
                    <td key={t.id}
                        title={override ? 'Teacher override set in Schoology' : undefined}
                        style={{
                      textAlign: 'center', fontWeight: 600, fontSize: '0.75rem',
                      padding: '0.25rem',
                      background: c ? c.bg : 'var(--bg-subtle)',
                      color: c ? c.text : 'var(--text-muted)',
                      border: '1px solid var(--border)',
                      borderTop: '2px solid var(--accent)',
                    }}>
                      {lvl || '—'}{pct != null ? ` (${Math.round(pct)})` : ''}{override ? '*' : ''}
                    </td>
                  );
                })
              )}
            </tr>
          )}

          {/* Schoology Reported — per Reporting Category.
              Bounded with an accent border on all four sides to distinguish it
              as the "official" row. Click a cell to set/clear the teacher
              override that Schoology stores server-side. */}
          <tr>
            <td style={{
              ...labelCellStyle,
              color: 'var(--accent)',
              background: 'var(--accent-subtle)',
              borderTop: '3px solid var(--accent)',
              borderBottom: '3px solid var(--accent)',
              borderLeft: '3px solid var(--accent)',
              fontWeight: 700,
            }}>
              Schoology Reported
              <br /><span style={{ fontWeight: 400, fontSize: '0.65rem' }}>per Reporting Category</span>
            </td>
            {categories.map((cat, idx) => {
              const lvl = rollupLevel(cat.id);
              const pct = rollupPct(cat.id);
              const override = rollupIsOverride(cat.id);
              const c = lvl ? LEVEL_COLORS[lvl] : null;
              const isLast = idx === categories.length - 1;
              return (
                <td key={cat.id} colSpan={cat.topics.length}
                    className="schoology-cell"
                    onClick={() => setOverrideTarget({ category: cat, currentLevel: lvl, hasOverride: override })}
                    title={override ? 'Teacher override set in Schoology — click to change or clear' : 'Click to set a teacher override in Schoology'}
                    style={{
                  textAlign: 'center', fontWeight: 700, fontSize: '0.85rem',
                  padding: '0.35rem',
                  background: c ? c.bg : 'var(--bg-subtle)',
                  color: c ? c.text : 'var(--text-muted)',
                  border: '1px solid var(--border)',
                  borderTop: '3px solid var(--accent)',
                  borderBottom: '3px solid var(--accent)',
                  borderRight: isLast ? '3px solid var(--accent)' : '1px solid var(--border)',
                  cursor: 'pointer',
                }}>
                  {lvl || '—'}{pct != null ? ` (${pct.toFixed(1)})` : ''}{override ? '*' : ''}
                </td>
              );
            })}
          </tr>
        </tfoot>
      </table>
    </div>
  ) : null;

  return (
    <div style={{ marginBottom: '1.25rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
        <h4 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>Mastery Performance Summary</h4>
        <button
          className="ghost"
          onClick={() => setExpanded(true)}
          style={{ fontSize: '0.72rem', padding: '0.15rem 0.4rem' }}
          title="Expand table to full screen"
        >
          Expand ↗
        </button>
      </div>

      {showGradeScale && (
        <LetterGradePopup onClose={() => setShowGradeScale(false)} numCategories={categories.length} />
      )}

      {overrideTarget && (
        <OverridePopup
          courseId={courseId}
          studentUid={studentUid}
          objectiveId={overrideTarget.category.id}
          objectiveTitle={overrideTarget.category.title}
          currentLevel={overrideTarget.currentLevel}
          hasOverride={overrideTarget.hasOverride}
          saving={overrideSaving}
          setSaving={setOverrideSaving}
          onClose={() => setOverrideTarget(null)}
          onSaved={async () => { const fresh = await getMasteryForStudent(courseId, studentUid); setData(fresh); }}
        />
      )}

      {expanded && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '1rem',
          }}
          onClick={() => setExpanded(false)}
        >
          <div
            style={{
              background: 'var(--card-bg)', borderRadius: 12,
              padding: '1.5rem', width: '95vw', maxWidth: 1400,
              maxHeight: '90vh', overflow: 'auto',
              boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0 }}>Mastery Performance Summary</h3>
              <button className="ghost" onClick={() => setExpanded(false)}>✕</button>
            </div>
            {masteryTable}
          </div>
        </div>
      )}

      {assignmentIds.length === 0 ? (
        <p className="text-sm text-muted">No mastery data yet. Run a mastery sync for this course.</p>
      ) : masteryTable}

      {/* Letter grade + grade scale link below table */}
      {letterGrade && assignmentIds.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.5rem' }}>
          <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-muted)' }}>Approximate letter grade:</span>
          <span style={{
            padding: '0.15rem 0.6rem', borderRadius: 6, fontWeight: 700, fontSize: '0.9rem',
            background: '#f8fafc', border: '2px solid var(--border)',
            color: LETTER_GRADE_COLORS[letterGrade] || 'var(--text)',
          }}>
            {letterGrade}
          </span>
          <button
            className="ghost"
            onClick={() => setShowGradeScale(true)}
            style={{ fontSize: '0.72rem', padding: '0.15rem 0.4rem' }}
          >
            Letter Grade Scale ↗
          </button>
        </div>
      )}
    </div>
  );
}
