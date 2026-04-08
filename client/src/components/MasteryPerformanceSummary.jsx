import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getMasteryForStudent } from '../services/api.js';

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

const LETTER_GRADE_COLORS = {
  A: '#166534', 'A-': '#15803d',
  'B+': '#1d4ed8', B: '#2563eb', 'B-': '#3b82f6',
  'C+': '#b45309', C: '#d97706',
  D: '#c2410c', F: '#991b1b',
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

// Approximate letter grade — based on HKIS General Academic Scale.
// NOTE: this is an approximation of the full combination table.
// See the letter grade popup for the authoritative HKIS scale.
function computeLetterGrade(categoryLevels) {
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

function LetterGradePopup({ onClose, numCategories }) {
  // Each row: [letterGrade, combinations per (2/3/4/5) reporting categories]
  // Approximate from HKIS General Academic Scale
  const scale = [
    { grade: 'A',   bg: '#dcfce7', rows: { 2: '2ED', 3: '3ED', 4: '4ED', 5: '5ED' } },
    { grade: 'A-',  bg: '#dcfce7', rows: { 2: '1ED / 1EX', 3: '2ED / 1EX', 4: '3ED / 1EX', 5: '4ED / 1EX\n3ED / 2EX' } },
    { grade: 'B+',  bg: '#dbeafe', rows: { 2: '2EX\n1ED / 1D', 3: '1ED / 2EX\n3EX', 4: '2ED / 2EX\n1ED / 3EX\n4EX', 5: '3ED / 2EX\n2ED / 3EX\n1ED / 4EX\n5EX' } },
    { grade: 'B',   bg: '#dbeafe', rows: { 2: '1EX / 1D\n1ED / 1EM', 3: '1ED / 1EX / 1D\n2EX / 1D\n1ED / 2D', 4: '1ED / 1EX / 2D\n2EX / 2D\n3EX / 1D', 5: '1ED / 2EX / 2D\n3EX / 2D' } },
    { grade: 'B-',  bg: '#dbeafe', rows: { 2: '2D\n1EX / 1EM', 3: '1EX / 2D\n1ED / 1D / 1EM\n3D', 4: '2EX / 1D / 1EM\n1EX / 3D\n4D', 5: '2EX / 3D\n1EX / 4D\n5D' } },
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

function LevelCell({ grade, size = 'md', dim = false }) {
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

  useEffect(() => {
    if (!courseId || !studentUid) return;
    getMasteryForStudent(courseId, studentUid)
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [courseId, studentUid]);

  if (loading) return <p className="text-sm text-muted">Loading mastery data...</p>;
  if (!data || !data.topics?.length) return null;

  const { topics, scores } = data;

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

  // Get unique assignments from scores, preserve order (or sort by assignment title)
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

  const topicAvg = {}; // topic.id → avg points (or null)
  const topicMode = {};
  const topicCount = {};
  for (const t of topics) {
    const vals = topicScores[t.id];
    topicAvg[t.id] = average(vals);
    topicMode[t.id] = modeOf(vals);
    topicCount[t.id] = vals.length;
  }

  // Per category: average of topic averages
  const catAvg = {};
  for (const cat of categories) {
    const avgs = cat.topics.map(t => topicAvg[t.id]).filter(v => v != null);
    catAvg[cat.id] = average(avgs);
  }

  const categoryLevels = categories.map(cat => pointsToLevel(catAvg[cat.id]));
  const letterGrade = computeLetterGrade(categoryLevels);

  const thStyle = {
    background: 'var(--bg-subtle)', padding: '0.35rem 0.5rem',
    fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-muted)',
    textAlign: 'center', border: '1px solid var(--border)', whiteSpace: 'nowrap',
  };
  const labelCellStyle = {
    padding: '0.3rem 0.6rem', fontSize: '0.75rem', fontWeight: 600,
    color: 'var(--text-muted)', background: 'var(--bg-subtle)',
    border: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'right',
  };
  const sectionLabelStyle = {
    ...labelCellStyle, background: 'var(--bg)', fontStyle: 'italic', color: 'var(--text-muted)',
  };

  return (
    <div style={{ marginBottom: '1.25rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
        <h4 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>Mastery Performance Summary</h4>
        {letterGrade && (
          <span style={{
            padding: '0.15rem 0.6rem', borderRadius: 6, fontWeight: 700, fontSize: '0.9rem',
            background: '#f8fafc', border: '2px solid var(--border)',
            color: LETTER_GRADE_COLORS[letterGrade] || 'var(--text)',
          }}>
            {letterGrade}
          </span>
        )}
        <button
          className="ghost"
          onClick={() => setShowGradeScale(true)}
          style={{ fontSize: '0.72rem', padding: '0.15rem 0.4rem', marginLeft: 'auto' }}
        >
          Letter Grade Scale ↗
        </button>
      </div>

      {showGradeScale && (
        <LetterGradePopup onClose={() => setShowGradeScale(false)} numCategories={categories.length} />
      )}

      {assignmentIds.length === 0 ? (
        <p className="text-sm text-muted">No mastery data yet. Run a mastery sync for this course.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: '0.8rem', width: '100%', minWidth: 500 }}>
            <thead>
              {/* Row 1: Reporting category headers */}
              <tr>
                <th style={{ ...thStyle, textAlign: 'right', minWidth: 160 }}>Reporting Categories</th>
                {categories.map(cat => (
                  <th
                    key={cat.id}
                    colSpan={cat.topics.length}
                    style={{
                      ...thStyle, fontWeight: 700,
                      background: 'var(--accent-muted, var(--bg-subtle))',
                      color: 'var(--accent)', borderBottom: '2px solid var(--accent)',
                    }}
                  >
                    {cat.title}
                  </th>
                ))}
              </tr>

              {/* Row 2: Reporting category averages */}
              <tr>
                <td style={{ ...labelCellStyle, color: 'var(--accent)', fontSize: '0.7rem' }}>
                  Reporting Category Average
                  <br /><span style={{ fontWeight: 400, fontSize: '0.65rem' }}>(of Measurement Topic Averages)</span>
                </td>
                {categories.map(cat => {
                  const lvl = pointsToLevel(catAvg[cat.id]);
                  const c = lvl ? LEVEL_COLORS[lvl] : null;
                  return (
                    <td
                      key={cat.id}
                      colSpan={cat.topics.length}
                      style={{
                        textAlign: 'center', fontWeight: 700, fontSize: '0.85rem',
                        padding: '0.3rem',
                        background: c ? c.bg : 'var(--bg-subtle)',
                        color: c ? c.text : 'var(--text-muted)',
                        border: '1px solid var(--border)',
                      }}
                    >
                      {lvl || '—'}{catAvg[cat.id] != null ? ` (${catAvg[cat.id].toFixed(1)})` : ''}
                    </td>
                  );
                })}
              </tr>

              {/* Row 3: Measurement topic headers */}
              <tr>
                <th style={{ ...thStyle, textAlign: 'right' }}>Measurement Topics</th>
                {categories.flatMap(cat =>
                  cat.topics.map(t => (
                    <th key={t.id} style={{ ...thStyle, maxWidth: 100, whiteSpace: 'normal', lineHeight: 1.2 }}>
                      <span title={t.title}>{t.external_id || t.title}</span>
                    </th>
                  ))
                )}
              </tr>

              {/* Row 4: Measurement topic averages */}
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

              {/* Row 5: Times assessed */}
              <tr>
                <td style={labelCellStyle}>Number of Times Assessed</td>
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
              {/* Summative assessment rows */}
              <tr>
                <td colSpan={1 + topics.length} style={{ ...sectionLabelStyle, textAlign: 'center', fontStyle: 'italic', fontSize: '0.68rem', padding: '0.2rem' }}>
                  Summative Assessments
                </td>
              </tr>
              {assignmentIds.map(aid => (
                <tr key={aid}>
                  <td style={{
                    padding: '0.3rem 0.6rem', border: '1px solid var(--border)',
                    fontSize: '0.78rem', background: 'var(--card-bg)',
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
                      return <LevelCell key={t.id} grade={sc?.grade || null} />;
                    })
                  )}
                </tr>
              ))}
            </tbody>

            <tfoot>
              {/* More Data section */}
              <tr>
                <td colSpan={1 + topics.length} style={{ ...sectionLabelStyle, textAlign: 'center', fontSize: '0.68rem', padding: '0.2rem' }}>
                  More Data
                </td>
              </tr>

              {/* Topic Mode */}
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

              {/* Category-level mode (across all assessments) */}
              <tr>
                <td style={labelCellStyle}>Mode across All Assessments</td>
                {categories.map(cat => {
                  const allPoints = cat.topics.flatMap(t => topicScores[t.id]);
                  const m = modeOf(allPoints);
                  const lvl = m != null ? pointsToLevel(m) : null;
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

              {/* Category-level average (across all assessments) */}
              <tr>
                <td style={labelCellStyle}>Average across All Assessments</td>
                {categories.map(cat => {
                  const allPoints = cat.topics.flatMap(t => topicScores[t.id]);
                  const avg = average(allPoints);
                  const lvl = pointsToLevel(avg);
                  const c = lvl ? LEVEL_COLORS[lvl] : null;
                  return (
                    <td key={cat.id} colSpan={cat.topics.length} style={{
                      textAlign: 'center', fontWeight: 600, fontSize: '0.78rem',
                      padding: '0.25rem',
                      background: c ? c.bg : 'var(--bg-subtle)',
                      color: c ? c.text : 'var(--text-muted)',
                      border: '1px solid var(--border)',
                    }}>
                      {lvl || '—'}{avg != null ? ` (${avg.toFixed(1)})` : ''}
                    </td>
                  );
                })}
              </tr>

              {/* Schoology reported row */}
              <tr>
                <td style={{ ...labelCellStyle, color: 'var(--accent)', background: 'var(--bg)' }}>
                  Schoology Reported
                  <br /><span style={{ fontWeight: 400, fontSize: '0.65rem' }}>per Reporting Category</span>
                </td>
                {categories.map(cat => (
                  <td key={cat.id} colSpan={cat.topics.length} style={{
                    textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.75rem',
                    padding: '0.3rem', border: '1px solid var(--border)',
                    fontStyle: 'italic',
                  }}>
                    — (sync mastery to populate)
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
