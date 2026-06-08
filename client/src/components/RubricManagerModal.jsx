import { useEffect, useRef, useState } from 'react';
import ReorderableList from './ReorderableList.jsx';
import {
  listRubrics, attachRubric, deleteRubric, setRubricMapping, reorderRubricCriteria,
  uploadRubricCsv, rubricTemplateUrl, rubricExportUrl,
} from '../services/api.js';

const fmtDate = (s) => (s ? new Date(s).toLocaleDateString('en-GB') : '');

export default function RubricManagerModal({ open, onClose, courseId, assignmentId, topics, attachment, onChanged }) {
  const [tab, setTab] = useState('attach');
  const [rubrics, setRubrics] = useState([]);
  const [confirmId, setConfirmId] = useState(null);
  const [msg, setMsg] = useState('');
  const fileRef = useRef(null);
  const hasAttachment = !!attachment;

  async function refresh() { setRubrics(await listRubrics()); }
  useEffect(() => {
    if (open) { refresh(); setTab(hasAttachment ? tab : 'attach'); setConfirmId(null); setMsg(''); }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- intentional: run on open; `tab` kept only to preserve current tab when an attachment exists

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function doAttach(rubricId) {
    setMsg('');
    try { await attachRubric({ rubricId, courseId, assignmentId }); await onChanged(); await refresh(); }
    catch (e) { setMsg(`Attach failed: ${e.message}`); }
  }
  async function doDelete(r) {
    if (confirmId !== r.id && r.attachment_count > 0) { setConfirmId(r.id); return; }
    try { await deleteRubric(r.id); setConfirmId(null); await onChanged(); await refresh(); }
    catch (e) { setMsg(`Delete failed: ${e.message}`); }
  }
  async function doUpload(file) {
    setMsg('');
    try { const { id } = await uploadRubricCsv(file.name.replace(/\.csv$/i, ''), file); await doAttach(id); }
    catch (e) { setMsg(`Upload failed: ${e.message}`); }
  }
  async function doMap(criterionId, topicId) {
    try { await setRubricMapping(attachment.id, criterionId, topicId || null); await onChanged(); }
    catch (e) { setMsg(`Map failed: ${e.message}`); }
  }
  async function doReorder(orderedIds) {
    try { await reorderRubricCriteria(attachment.rubric.id, orderedIds); await onChanged(); }
    catch (e) { setMsg(`Reorder failed: ${e.message}`); }
  }

  const Tab = ({ id, label, disabled }) => (
    <button role="tab" aria-selected={tab === id} disabled={disabled}
      className={`filter-btn${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>{label}</button>
  );

  return (
    <div role="dialog" aria-modal="true" aria-label="Manage rubrics" style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex',
      alignItems: 'flex-start', justifyContent: 'center', zIndex: 100, paddingTop: '6vh' }}
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 540, maxWidth: '92vw', maxHeight: '84vh', overflow: 'auto', background: 'var(--card-bg)',
        border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.25)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '0.7rem 1rem', borderBottom: '1px solid var(--border)' }}>
          <strong>Manage rubrics</strong>
          <button className="ghost" aria-label="Close" onClick={onClose}>✕</button>
        </div>

        <div role="tablist" style={{ display: 'flex', gap: '0.3rem', padding: '0.6rem 1rem 0' }}>
          <Tab id="attach" label="Attach" />
          <Tab id="map" label="Map criteria" disabled={!hasAttachment} />
          <Tab id="order" label="Row order" disabled={!hasAttachment} />
        </div>

        <div style={{ padding: '0.8rem 1rem' }}>
          {tab === 'attach' && (
            <div>
              {rubrics.map((r) => (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem',
                  padding: '0.45rem 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ flex: 1 }}>
                    {attachment?.rubric?.id === r.id && <span style={{ color: 'var(--success)' }}>✓ </span>}
                    <strong>{r.name}</strong>
                    <span className="text-muted" style={{ fontSize: '0.72rem', marginLeft: 6 }}>
                      {r.criteria_count} criteria · {fmtDate(r.updated_at)}
                      {r.attachment_count > 0 ? ` · attached to ${r.attachment_count}` : ''}
                    </span>
                  </span>
                  <button className="secondary" onClick={() => doAttach(r.id)}>Attach</button>
                  <a className="ghost" href={rubricExportUrl(r.id)} download>⬇ CSV</a>
                  <button className="ghost danger" onClick={() => doDelete(r)}
                    aria-label={confirmId === r.id ? `Click to confirm delete ${r.name}` : `Delete ${r.name}`}>
                    {confirmId === r.id ? 'Click to confirm' : '🗑'}
                  </button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', marginTop: '0.8rem' }}>
                <button className="secondary" onClick={() => fileRef.current?.click()}>⬆ Upload CSV</button>
                <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) doUpload(f); e.target.value = ''; }} />
                <a className="ghost" href={rubricTemplateUrl()} download style={{ fontSize: '0.8rem' }}>⬇ Download template</a>
              </div>
              {msg && <p className="text-muted" style={{ fontSize: '0.75rem', marginTop: 6 }}>{msg}</p>}
            </div>
          )}

          {tab === 'map' && hasAttachment && (
            <MapTab attachment={attachment} topics={topics} onMap={doMap} />
          )}

          {tab === 'order' && hasAttachment && (
            <ReorderableList
              items={[...attachment.rubric.criteria].sort((a, b) => a.position - b.position).map((c) => ({
                id: c.id, label: c.criterion_name,
                content: (
                  <span>
                    <strong>{c.criterion_name}</strong>
                    <span className="text-muted" style={{ fontSize: '0.72rem' }}>
                      {' '}→ {topicTitle(topics, mappedTopic(attachment, c.id))}
                    </span>
                    {c.descriptors?.ED && <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{c.descriptors.ED}</div>}
                  </span>
                ),
              }))}
              onReorder={doReorder}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function mappedTopic(attachment, criterionId) {
  return attachment.topicByCriterion.find((m) => m.criterion_id === criterionId)?.topic_id ?? '';
}
function topicTitle(topics, topicId) {
  return topics.find((t) => t.id === topicId)?.title ?? '— unmapped —';
}

function MapTab({ attachment, topics, onMap }) {
  const taken = new Set(attachment.topicByCriterion.map((m) => m.topic_id));
  const ordered = [...attachment.rubric.criteria].sort((a, b) => a.position - b.position);
  return (
    <div>
      {ordered.map((c) => {
        const current = mappedTopic(attachment, c.id);
        const options = topics.filter((t) => !taken.has(t.id) || t.id === current);
        return (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 0',
            borderBottom: '1px solid var(--border)' }}>
            <span style={{ flex: 1 }}>
              <span style={{ color: current ? 'var(--success)' : 'var(--warning)' }}>{current ? '✓' : '⚠'}</span>{' '}
              <strong>{c.criterion_name}</strong>
              <span className="text-muted" style={{ fontSize: '0.72rem' }}> expects “{c.standard_title}”</span>
            </span>
            <select aria-label={`Topic for ${c.criterion_name}`} value={current}
              onChange={(e) => onMap(c.id, e.target.value)}>
              <option value="">— none —</option>
              {options.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
          </div>
        );
      })}
    </div>
  );
}
