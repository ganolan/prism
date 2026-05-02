import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  getFeedback, getFeedbackItem, updateFeedback, approveFeedback,
  requestRevision, batchApproveFeedback, processInbox, deleteFeedback,
  uploadFeedbackJson, createManualFeedback, getCourses, getCourseStudents,
  getCourseAssignments, getGradingScales,
} from '../services/api.js';
import { gradeLabel } from '../lib/gradeLabel.js';

const STATUS_COLORS = {
  draft: 'badge-gray',
  approved: 'badge-green',
  teacher_modified: 'badge-blue',
  revision_requested: 'badge-red',
  revised: 'badge-blue',
};

export default function FeedbackPage() {
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState('');
  const [courseFilter, setCourseFilter] = useState('');
  const [courses, setCourses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [inboxResult, setInboxResult] = useState(null);
  const [showManual, setShowManual] = useState(false);
  const [scales, setScales] = useState({});

  function reload() {
    const params = {};
    if (filter) params.status = filter;
    if (courseFilter) params.course_id = courseFilter;
    if (filter === 'flagged') { delete params.status; params.flagged = 'true'; }
    getFeedback(params).then(setItems).catch(console.error).finally(() => setLoading(false));
  }

  useEffect(() => { reload(); }, [filter, courseFilter]);
  useEffect(() => { getCourses().then(setCourses); }, []);
  useEffect(() => { getGradingScales().then(setScales).catch(console.error); }, []);

  async function handleProcessInbox() {
    const result = await processInbox();
    setInboxResult(result);
    reload();
  }

  async function handleBatchApprove() {
    const draftIds = items.filter(i => (i.status === 'draft' || i.status === 'revised') && !i.flag_for_review).map(i => i.id);
    if (draftIds.length === 0) return;
    await batchApproveFeedback(draftIds);
    reload();
  }

  async function handleApprove(id) {
    await approveFeedback(id);
    if (selected?.id === id) setSelected(prev => ({ ...prev, status: 'approved' }));
    reload();
  }

  async function handleDelete(id) {
    await deleteFeedback(id);
    if (selected?.id === id) setSelected(null);
    reload();
  }

  const draftCount = items.filter(i => i.status === 'draft').length;
  const flaggedCount = items.filter(i => i.flag_for_review).length;
  const approvableCount = items.filter(i => (i.status === 'draft' || i.status === 'revised') && !i.flag_for_review).length;

  return (
    <div className="fade-in">
      <h2 className="page-title">Feedback Review</h2>

      {/* Action bar */}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem', alignItems: 'center' }}>
        <button className="primary" onClick={handleProcessInbox}>Process Inbox</button>
        <UploadButton onDone={reload} />
        <button className="secondary" onClick={() => setShowManual(!showManual)}>
          {showManual ? 'Cancel' : 'Manual Entry'}
        </button>
        {approvableCount > 0 && (
          <button className="primary" onClick={handleBatchApprove} style={{ background: 'var(--success)', marginLeft: 'auto' }}>
            Batch Approve ({approvableCount})
          </button>
        )}
      </div>

      {inboxResult && (
        <div className="alert alert-success" style={{ marginBottom: '1rem' }}>
          <p className="text-sm">Inbox: {inboxResult.processed} imported, {inboxResult.errors} errors</p>
          {inboxResult.details.filter(d => d.status === 'error').map((d, i) => (
            <p key={i} className="text-sm" style={{ color: 'var(--error)' }}>{d.file}: {d.error || d.errors?.join('; ')}</p>
          ))}
        </div>
      )}

      {showManual && <ManualEntry courses={courses} onDone={() => { setShowManual(false); reload(); }} />}

      {/* Filters */}
      <div style={{ display: 'flex', gap: '0.35rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        {['', 'draft', 'flagged', 'revision_requested', 'revised', 'teacher_modified', 'approved'].map(s => (
          <button key={s} onClick={() => setFilter(s)}
            className={`filter-btn ${filter === s ? 'active' : ''}`}>
            {s || 'All'} {s === 'draft' ? `(${draftCount})` : s === 'flagged' ? `(${flaggedCount})` : ''}
          </button>
        ))}
        <select value={courseFilter} onChange={e => setCourseFilter(e.target.value)} style={{ width: 'auto', fontSize: '0.8rem', marginLeft: 'auto' }}>
          <option value="">All courses</option>
          {courses.map(c => <option key={c.id} value={c.id}>{c.course_name}</option>)}
        </select>
      </div>

      {loading ? <div className="loading">Loading...</div> : (
        <div style={{ display: 'flex', gap: '1rem' }}>
          {/* List panel */}
          <div style={{ flex: '0 0 420px', maxHeight: '70vh', overflowY: 'auto' }}>
            {items.length === 0 ? (
              <div className="card empty-state"><p>No feedback items match the filter.</p></div>
            ) : items.map(item => (
              <div key={item.id} onClick={() => loadDetail(item.id)}
                className="card" style={{
                  cursor: 'pointer', padding: '0.75rem',
                  borderLeft: selected?.id === item.id ? `3px solid var(--accent)` : '3px solid transparent',
                  opacity: item.status === 'approved' ? 0.7 : 1,
                }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Link to={`/student/${item.student_id}`} className="link text-sm" onClick={e => e.stopPropagation()}>
                    {item.preferred_name || item.first_name} {item.last_name}
                  </Link>
                  <span className={`badge ${STATUS_COLORS[item.status] || 'badge-gray'}`}>{item.status.replace('_', ' ')}</span>
                </div>
                <p className="text-sm text-muted">{item.assignment_title}</p>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.25rem' }}>
                  {item.score != null && (() => {
                    const lbl = gradeLabel({ score: item.score, max_points: item.max_points, grading_scale_id: item.grading_scale_id, scales });
                    return <span className="text-sm" style={lbl.kind === 'mismatch' ? { color: 'var(--danger)' } : null} title={lbl.kind === 'mismatch' ? 'Score does not match any defined level on this grading scale — check Schoology' : undefined}>Score: {lbl.text}</span>;
                  })()}
                  {item.flag_for_review ? <span className="badge badge-red">Flagged</span> : null}
                  <span className="text-sm text-muted" style={{ marginLeft: 'auto' }}>{new Date(item.created_at).toLocaleDateString()}</span>
                </div>
              </div>
            ))}
          </div>

          {/* Detail panel */}
          <div style={{ flex: 1 }}>
            {selected ? (
              <FeedbackDetail
                item={selected}
                scales={scales}
                onApprove={() => handleApprove(selected.id)}
                onDelete={() => handleDelete(selected.id)}
                onUpdate={() => { loadDetail(selected.id); reload(); }}
              />
            ) : (
              <div className="card empty-state"><p>Select a feedback item to review.</p></div>
            )}
          </div>
        </div>
      )}
    </div>
  );

  async function loadDetail(id) {
    const item = await getFeedbackItem(id);
    setSelected(item);
  }
}

function FeedbackDetail({ item, scales, onApprove, onDelete, onUpdate }) {
  const [editing, setEditing] = useState(false);
  const [narrative, setNarrative] = useState('');
  const [score, setScore] = useState('');
  const [teacherNotes, setTeacherNotes] = useState('');
  const [revisionNotes, setRevisionNotes] = useState('');
  const [showDiff, setShowDiff] = useState(false);

  const fb = item.feedback_parsed || {};
  const history = item.revision_history_parsed || [];

  function startEdit() {
    setNarrative(fb.narrative_feedback || '');
    setScore(item.score ?? '');
    setTeacherNotes(item.teacher_notes || '');
    setEditing(true);
  }

  async function saveEdit() {
    const newFb = { ...fb, narrative_feedback: narrative };
    await updateFeedback(item.id, {
      score: score === '' ? null : parseFloat(score),
      feedback_json: JSON.stringify(newFb),
      teacher_notes: teacherNotes,
    });
    setEditing(false);
    onUpdate();
  }

  async function handleRequestRevision() {
    if (!revisionNotes.trim()) return;
    await requestRevision(item.id, revisionNotes);
    setRevisionNotes('');
    onUpdate();
  }

  return (
    <div>
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <div>
            <h3>
              <Link to={`/student/${item.student_id}`} className="link">
                {item.preferred_name || item.first_name} {item.last_name}
              </Link>
            </h3>
            <p className="text-sm text-muted">{item.assignment_title} — {item.course_name}</p>
          </div>
          <span className={`badge ${STATUS_COLORS[item.status]}`}>{item.status.replace('_', ' ')}</span>
        </div>

        {/* Score */}
        <div style={{ marginBottom: '0.75rem' }}>
          {editing ? (
            <label className="text-sm">
              Score
              <input type="number" value={score} onChange={e => setScore(e.target.value)} style={{ width: '100px' }} />
              {item.max_points && <span className="text-muted"> / {item.max_points}</span>}
            </label>
          ) : (
            (() => {
              if (item.score == null) return <p className="text-sm"><strong>Score:</strong> Not set</p>;
              const lbl = gradeLabel({ score: item.score, max_points: item.max_points, grading_scale_id: item.grading_scale_id, scales });
              return <p className="text-sm" style={lbl.kind === 'mismatch' ? { color: 'var(--danger)' } : null}><strong>Score:</strong> {lbl.text}</p>;
            })()
          )}
        </div>

        {/* Feedback content */}
        {fb.strengths?.length > 0 && (
          <div style={{ marginBottom: '0.5rem' }}>
            <strong className="text-sm">Strengths</strong>
            <ul style={{ paddingLeft: '1.25rem', margin: '0.25rem 0' }}>
              {fb.strengths.map((s, i) => <li key={i} className="text-sm">{s}</li>)}
            </ul>
          </div>
        )}

        {fb.suggestions?.length > 0 && (
          <div style={{ marginBottom: '0.5rem' }}>
            <strong className="text-sm">Suggestions</strong>
            <ul style={{ paddingLeft: '1.25rem', margin: '0.25rem 0' }}>
              {fb.suggestions.map((s, i) => <li key={i} className="text-sm">{s}</li>)}
            </ul>
          </div>
        )}

        {/* Narrative */}
        <div style={{ marginBottom: '0.75rem' }}>
          <strong className="text-sm">Narrative Feedback</strong>
          {editing ? (
            <textarea value={narrative} onChange={e => setNarrative(e.target.value)} rows={5}
              style={{ width: '100%', marginTop: '0.25rem' }} />
          ) : (
            <p className="text-sm" style={{ whiteSpace: 'pre-wrap', marginTop: '0.25rem', background: 'var(--bg-subtle)', padding: '0.5rem', borderRadius: 8 }}>
              {fb.narrative_feedback || '(none)'}
            </p>
          )}
        </div>

        {/* Rubric scores */}
        {fb.rubric_scores && Object.keys(fb.rubric_scores).length > 0 && (
          <div style={{ marginBottom: '0.75rem' }}>
            <strong className="text-sm">Rubric Scores</strong>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.25rem' }}>
              {Object.entries(fb.rubric_scores).map(([k, v]) => (
                <span key={k} className="badge badge-blue">{k}: {v}</span>
              ))}
            </div>
          </div>
        )}

        {/* Teacher notes */}
        <div style={{ marginBottom: '0.75rem' }}>
          <strong className="text-sm">Teacher Notes <span className="text-muted">(not student-facing)</span></strong>
          {editing ? (
            <textarea value={teacherNotes} onChange={e => setTeacherNotes(e.target.value)} rows={2}
              style={{ width: '100%', marginTop: '0.25rem' }} />
          ) : (
            <p className="text-sm text-muted" style={{ marginTop: '0.25rem' }}>{item.teacher_notes || '(none)'}</p>
          )}
        </div>

        {item.flag_for_review ? (
          <div className="alert alert-warning" style={{ marginBottom: '0.75rem' }}>
            <span className="badge badge-red">Flagged</span>
            <span className="text-sm" style={{ marginLeft: '0.5rem' }}>{item.flag_reason || 'Flagged for review'}</span>
          </div>
        ) : null}

        {/* Actions */}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
          {editing ? (
            <>
              <button className="primary" onClick={saveEdit}>Save Changes</button>
              <button className="secondary" onClick={() => setEditing(false)}>Cancel</button>
            </>
          ) : (
            <>
              <button className="primary" onClick={startEdit}>Edit</button>
              {item.status !== 'approved' && (
                <button className="primary" onClick={onApprove} style={{ background: 'var(--success)' }}>Approve</button>
              )}
              <button className="secondary" onClick={() => setShowDiff(!showDiff)}>
                {showDiff ? 'Hide History' : `History (${history.length})`}
              </button>
              <button className="ghost danger" onClick={onDelete} style={{ marginLeft: 'auto', border: '1px solid var(--error)', padding: '0.5rem 1rem', borderRadius: 8 }}>Delete</button>
            </>
          )}
        </div>

        {/* Revision request */}
        {!editing && item.status !== 'approved' && (
          <div style={{ marginTop: '0.75rem', borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
            <strong className="text-sm">Request Revision</strong>
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
              <input type="text" placeholder="Revision notes..." value={revisionNotes}
                onChange={e => setRevisionNotes(e.target.value)} style={{ flex: 1 }} />
              <button className="primary" onClick={handleRequestRevision} disabled={!revisionNotes.trim()}
                style={{ background: 'var(--warning)' }}>Request Revision</button>
            </div>
          </div>
        )}
      </div>

      {/* Diff / history view */}
      {showDiff && history.length > 0 && (
        <div className="card" style={{ marginTop: '0.5rem' }}>
          <h3 style={{ marginBottom: '0.5rem' }}>Revision History</h3>
          {history.map((h, i) => {
            const hFb = JSON.parse(h.feedback_json || '{}');
            return (
              <div key={i} style={{ padding: '0.5rem', background: 'var(--bg-subtle)', borderRadius: 8, marginBottom: '0.5rem', border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                  <span className="text-sm text-muted">Version {i + 1} — {h.status}</span>
                  <span className="text-sm text-muted">{new Date(h.changed_at).toLocaleString()}</span>
                </div>
                {h.score != null && (() => {
                  const lbl = gradeLabel({ score: h.score, max_points: item.max_points, grading_scale_id: item.grading_scale_id, scales });
                  return <p className="text-sm" style={lbl.kind === 'mismatch' ? { color: 'var(--danger)' } : null}>Score: {lbl.text}</p>;
                })()}
                <p className="text-sm" style={{ whiteSpace: 'pre-wrap' }}>{hFb.narrative_feedback || '(no narrative)'}</p>
                {hFb.narrative_feedback !== fb.narrative_feedback && (
                  <p className="text-sm" style={{ color: 'var(--accent)', marginTop: '0.25rem' }}>
                    (narrative changed in later version)
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
      {showDiff && history.length === 0 && (
        <div className="card" style={{ marginTop: '0.5rem' }}>
          <p className="text-muted text-sm">No revision history yet.</p>
        </div>
      )}
    </div>
  );
}

function UploadButton({ onDone }) {
  const [uploading, setUploading] = useState(false);

  async function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    try {
      await uploadFeedbackJson(file);
      onDone();
    } catch (err) {
      console.error(err);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  return (
    <label style={{
      display: 'inline-flex', alignItems: 'center', cursor: 'pointer',
      background: 'var(--accent)', color: 'white', padding: '0.5rem 1rem', borderRadius: 8, fontSize: '0.85rem', fontWeight: 600,
      transition: 'all 0.15s ease',
    }}>
      {uploading ? 'Uploading...' : 'Upload JSON'}
      <input type="file" accept=".json" onChange={handleFile} style={{ display: 'none' }} />
    </label>
  );
}

function ManualEntry({ courses, onDone }) {
  const [courseId, setCourseId] = useState('');
  const [students, setStudents] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [form, setForm] = useState({ student_id: '', assignment_id: '', score: '', narrative_feedback: '', strengths: '', suggestions: '' });

  useEffect(() => {
    if (courseId) {
      getCourseStudents(courseId).then(setStudents);
      getCourseAssignments(courseId).then(setAssignments);
    }
  }, [courseId]);

  async function handleSubmit(e) {
    e.preventDefault();
    await createManualFeedback({
      student_id: parseInt(form.student_id),
      assignment_id: parseInt(form.assignment_id),
      score: form.score ? parseFloat(form.score) : null,
      narrative_feedback: form.narrative_feedback,
      strengths: form.strengths ? form.strengths.split('\n').filter(Boolean) : [],
      suggestions: form.suggestions ? form.suggestions.split('\n').filter(Boolean) : [],
    });
    onDone();
  }

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <h3 style={{ marginBottom: '0.75rem' }}>Manual Feedback Entry</h3>
      <form onSubmit={handleSubmit} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', maxWidth: '600px' }}>
        <div>
          <label className="text-sm">Course</label>
          <select value={courseId} onChange={e => setCourseId(e.target.value)} required>
            <option value="">Select...</option>
            {courses.map(c => <option key={c.id} value={c.id}>{c.course_name}</option>)}
          </select>
        </div>
        <div>
          <label className="text-sm">Student</label>
          <select value={form.student_id} onChange={e => setForm(f => ({ ...f, student_id: e.target.value }))} required>
            <option value="">Select...</option>
            {students.map(s => <option key={s.id} value={s.id}>{s.preferred_name || s.first_name} {s.last_name}</option>)}
          </select>
        </div>
        <div>
          <label className="text-sm">Assignment</label>
          <select value={form.assignment_id} onChange={e => setForm(f => ({ ...f, assignment_id: e.target.value }))} required>
            <option value="">Select...</option>
            {assignments.map(a => <option key={a.id} value={a.id}>{a.title}</option>)}
          </select>
        </div>
        <div>
          <label className="text-sm">Score</label>
          <input type="number" value={form.score} onChange={e => setForm(f => ({ ...f, score: e.target.value }))} />
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <label className="text-sm">Narrative Feedback</label>
          <textarea value={form.narrative_feedback} onChange={e => setForm(f => ({ ...f, narrative_feedback: e.target.value }))}
            rows={3} />
        </div>
        <div>
          <label className="text-sm">Strengths (one per line)</label>
          <textarea value={form.strengths} onChange={e => setForm(f => ({ ...f, strengths: e.target.value }))}
            rows={2} />
        </div>
        <div>
          <label className="text-sm">Suggestions (one per line)</label>
          <textarea value={form.suggestions} onChange={e => setForm(f => ({ ...f, suggestions: e.target.value }))}
            rows={2} />
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <button className="primary" type="submit" disabled={!form.student_id || !form.assignment_id}>Create Feedback</button>
        </div>
      </form>
    </div>
  );
}
