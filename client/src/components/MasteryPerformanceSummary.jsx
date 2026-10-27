import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getMasteryForStudent } from '../services/api.js';
import OverridePopup from './OverridePopup.jsx';
import { LEVEL_COLORS, CELL_TEXT, LETTER_GRADE_COLORS, computeLetterGrade } from '../lib/masteryLevels.js';
import { GradeScaleHelp } from './GradeScale.jsx';
import { chartCovers } from '../lib/hkisLetterGrade.js';
import { useProficiencyScale } from '../hooks/useProficiencyScale.js';
import { categoryLabels } from '../lib/categoryAbbr.js';
import CategoryTag from './CategoryTag.jsx';
import { Tip } from './HelpDot.jsx';


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

// A cell's value with its hint as the instant popover (AGENTS.md: hover text is never a `title`).
function Hinted({ value, hint }) {
  return hint ? <Tip text={`${value}. ${hint}`} pop={hint}>{value}</Tip> : value;
}

function sentenceCase(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

// ── Cell component ───────────────────────────────────────────────────────────

function LevelCell({ grade, size = 'md', dim = false, pending = false }) {
  if (!grade && pending) return <td style={{ background: 'var(--bg-subtle)', color: 'var(--text-muted)', textAlign: 'center', padding: size === 'sm' ? '0.2rem 0.3rem' : '0.35rem 0.5rem', fontStyle: 'italic', fontSize: '0.68rem' }}>Pending</td>;
  if (!grade) return <td style={{ background: 'var(--bg-subtle)', color: 'var(--text-muted)', textAlign: 'center', padding: size === 'sm' ? '0.2rem 0.3rem' : '0.35rem 0.5rem', opacity: dim ? 0.45 : 1 }}>-</td>;
  const c = LEVEL_COLORS[grade] || {};
  return (
    <td style={{
      background: c.headerFill, color: CELL_TEXT,
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

// reloadKey: a change reloads the data (the student page bumps it after a refresh from Schoology, #52).
// canOverride: false on a course Prism does not write to (archived, excluded, linked: #188); the
// Schoology cells then say so instead of opening the override.
export default function MasteryPerformanceSummary({ courseId, studentUid, courseName, reloadKey = 0, canOverride = true }) {
  const scale = useProficiencyScale();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [overrideTarget, setOverrideTarget] = useState(null); // { category, currentLevel, hasOverride }
  const [overrideSaving, setOverrideSaving] = useState(false);

  useEffect(() => {
    if (!courseId || !studentUid) return;
    getMasteryForStudent(courseId, studentUid)
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [courseId, studentUid, reloadKey]);

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
    return v != null ? scale.pointsToLevel(v) : null;
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
  // Each category as its short label (P, CRC), full name on hover: a category may span one narrow topic column (#196).
  const catLabels = categoryLabels(categories.map(cat => cat.title));

  // Show every aligned assignment (with or without scores), ordered by the
  // server-side gradebook order in `alignments`. Any score-only assignments
  // (shouldn't normally happen) are appended at the end so we don't drop data.
  const assignmentIdSet = new Set();
  const assignmentIds = [];
  const assignmentTitles = {};
  for (const a of (alignments || [])) {
    const aid = a.assignment_schoology_id;
    if (!assignmentIdSet.has(aid)) {
      assignmentIdSet.add(aid);
      assignmentIds.push(aid);
    }
    if (a.assignment_title) assignmentTitles[aid] = a.assignment_title;
  }
  for (const s of scores) {
    const aid = s.assignment_schoology_id;
    if (!assignmentIdSet.has(aid)) {
      assignmentIdSet.add(aid);
      assignmentIds.push(aid);
    }
    if (s.assignment_title && !assignmentTitles[aid]) assignmentTitles[aid] = s.assignment_title;
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
  const categoryLevels = categories.map(cat => scale.pointsToLevel(catFlatAvg[cat.id]));
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
                {catLabels.get(cat.title) ? <CategoryTag label={catLabels.get(cat.title)} /> : cat.title}
              </th>
            ))}
          </tr>

          {/* Row 2: Measurement topic headers */}
          <tr>
            <th style={{ ...thStyle, ...stickyCol, textAlign: 'right', minWidth: 100, maxWidth: 180, background: 'var(--bg-subtle)' }}>Measurement Topics</th>
            {categories.flatMap(cat =>
              cat.topics.map(t => (
                <th key={t.id} style={{ ...thStyle, maxWidth: 120, minWidth: 60, whiteSpace: 'normal', lineHeight: 1.2, fontSize: '0.65rem', fontWeight: 500 }}>
                  <span>{t.external_id} {sentenceCase(t.title)}</span>
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
                const lvl = topicMode[t.id] != null ? scale.pointsToLevel(topicMode[t.id]) : null;
                const c = lvl ? LEVEL_COLORS[lvl] : null;
                return (
                  <td key={t.id} style={{
                    textAlign: 'center', fontWeight: 600, fontSize: '0.75rem',
                    padding: '0.25rem',
                    background: c ? c.headerFill : 'var(--bg-subtle)',
                    color: c ? CELL_TEXT : 'var(--text-muted)',
                    border: '1px solid var(--border)',
                  }}>
                    {lvl || '-'}
                  </td>
                );
              })
            )}
          </tr>

          {/* Reporting Category Mode (flat mode of all proficiency scores in the category) */}
          <tr>
            <td style={labelCellStyle}>Reporting Category Mode<br /><span style={{ fontWeight: 400, fontSize: '0.65rem' }}>(of all proficiencies)</span></td>
            {categories.map(cat => {
              const lvl = catFlatMode[cat.id] != null ? scale.pointsToLevel(catFlatMode[cat.id]) : null;
              const c = lvl ? LEVEL_COLORS[lvl] : null;
              return (
                <td key={cat.id} colSpan={cat.topics.length} style={{
                  textAlign: 'center', fontWeight: 600, fontSize: '0.78rem',
                  padding: '0.25rem',
                  background: c ? c.headerFill : 'var(--bg-subtle)',
                  color: c ? CELL_TEXT : 'var(--text-muted)',
                  border: '1px solid var(--border)',
                }}>
                  {lvl || '-'}
                </td>
              );
            })}
          </tr>

          {/* Measurement Topic Average */}
          <tr>
            <td style={labelCellStyle}>Measurement Topic Average</td>
            {categories.flatMap(cat =>
              cat.topics.map(t => {
                const lvl = scale.pointsToLevel(topicAvg[t.id]);
                const c = lvl ? LEVEL_COLORS[lvl] : null;
                return (
                  <td key={t.id} style={{
                    textAlign: 'center', fontWeight: 600, fontSize: '0.75rem',
                    padding: '0.25rem',
                    background: c ? c.headerFill : 'var(--bg-subtle)',
                    color: c ? CELL_TEXT : 'var(--text-muted)',
                    border: '1px solid var(--border)',
                  }}>
                    {lvl || '-'}{topicAvg[t.id] != null ? ` (${topicAvg[t.id].toFixed(0)})` : ''}
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
              const lvl = scale.pointsToLevel(avg);
              const c = lvl ? LEVEL_COLORS[lvl] : null;
              return (
                <td key={cat.id} colSpan={cat.topics.length} style={{
                  textAlign: 'center', fontWeight: 700, fontSize: '0.85rem',
                  padding: '0.3rem',
                  background: c ? c.headerFill : 'var(--bg-subtle)',
                  color: c ? CELL_TEXT : 'var(--text-muted)',
                  border: '1px solid var(--border)',
                }}>
                  {lvl || '-'}{avg != null ? ` (${avg.toFixed(1)})` : ''}
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
                        style={{
                      textAlign: 'center', fontWeight: 600, fontSize: '0.75rem',
                      padding: '0.25rem',
                      background: c ? c.headerFill : 'var(--bg-subtle)',
                      color: c ? CELL_TEXT : 'var(--text-muted)',
                      border: '1px solid var(--border)',
                      borderTop: '2px solid var(--accent)',
                    }}>
                      <Hinted value={`${lvl || '-'}${pct != null ? ` (${Math.round(pct)})` : ''}${override ? '*' : ''}`}
                        hint={override ? 'Teacher override set in Schoology' : null} />
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
                    onClick={canOverride ? () => setOverrideTarget({ category: cat, currentLevel: lvl, hasOverride: override }) : undefined}
                    style={{
                  textAlign: 'center', fontWeight: 700, fontSize: '0.85rem',
                  padding: '0.35rem',
                  background: c ? c.headerFill : 'var(--bg-subtle)',
                  color: c ? CELL_TEXT : 'var(--text-muted)',
                  border: '1px solid var(--border)',
                  borderTop: '3px solid var(--accent)',
                  borderBottom: '3px solid var(--accent)',
                  borderRight: isLast ? '3px solid var(--accent)' : '1px solid var(--border)',
                  cursor: canOverride ? 'pointer' : 'default',
                }}>
                  <Hinted value={`${lvl || '-'}${pct != null ? ` (${pct.toFixed(1)})` : ''}${override ? '*' : ''}`}
                    hint={!canOverride ? `${override ? 'Teacher override set in Schoology. ' : ''}Prism does not write to Schoology for this course.`
                      : override ? 'Teacher override set in Schoology, click to change or clear' : 'Click to set a teacher override in Schoology'} />
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
        <Tip
          as="button"
          type="button"
          named={false}
          text="Expand table to full screen"
          className="ghost"
          onClick={() => setExpanded(true)}
          style={{ fontSize: '0.72rem', padding: '0.15rem 0.4rem' }}
        >
          Expand ↗
        </Tip>
      </div>


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

      {/* Letter grade + the grade scale "?" below table */}
      {(letterGrade || (categories.length > 0 && !chartCovers(categories.length))) && assignmentIds.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.5rem' }}>
          <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-muted)' }}>Letter grade:</span>
          <span style={{
            padding: '0.15rem 0.6rem', borderRadius: 6, fontWeight: 700, fontSize: '0.9rem',
            background: 'var(--card-bg)', border: '2px solid var(--border)',
            color: LETTER_GRADE_COLORS[letterGrade] || 'var(--text)',
          }}>
            {letterGrade ?? '-'}
          </span>
          <GradeScaleHelp numCategories={categories.length} />
        </div>
      )}
    </div>
  );
}
