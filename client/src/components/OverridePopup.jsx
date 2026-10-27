import { useState } from 'react';
import { writeMasteryOverride } from '../services/api.js';
import { LEVELS, LEVEL_LABELS, LEVEL_COLORS, CELL_TEXT } from '../lib/masteryLevels.js';
import { Tip } from './HelpDot.jsx';

/**
 * Modal for setting/clearing Schoology's per-(student, objective) outcome override.
 *
 * Props:
 *   courseId         Prism course id (number)
 *   studentUid       Schoology user id
 *   objectiveId      UUID (reporting category or measurement topic)
 *   objectiveTitle   Label to show in header
 *   currentLevel     Current level string ("ED" / "EX" / …) or null
 *   hasOverride      Whether an override is currently set
 *   suggestedLevel   The level Prism calculates (the Roster tab's Mastery mode, #160). When it is set and
 *                    differs from currentLevel, "Override Schoology to {level}" comes first.
 *   saving, setSaving, onClose, onSaved
 *
 * The server re-reads Schoology before the write and reads it back after (#188). A refusal shows here; when
 * Schoology had changed (CHANGED) or the read-back disagrees (MISMATCH), Prism has stored what Schoology
 * holds, so onSaved re-reads it and the levels behind the pop-up are current.
 */
export default function OverridePopup({
  courseId, studentUid, objectiveId, objectiveTitle,
  currentLevel, hasOverride, suggestedLevel = null,
  saving, setSaving, onClose, onSaved,
}) {
  const suggest = suggestedLevel && suggestedLevel !== currentLevel ? suggestedLevel : null;
  const [error, setError] = useState(null);
  async function save(level) {
    setSaving(true);
    setError(null);
    try {
      await writeMasteryOverride(courseId, { studentUid, objectiveId, level });
      await onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message);
      if (err.code === 'CHANGED' || err.code === 'MISMATCH') await Promise.resolve(onSaved?.()).catch(() => {});
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1100,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1rem',
      }}
      onClick={() => !saving && onClose()}
    >
      <div
        style={{
          background: 'var(--card-bg)', borderRadius: 12,
          padding: '1.25rem 1.5rem', maxWidth: 420, width: '100%',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <h4 style={{ margin: '0 0 0.25rem 0' }}>Override Schoology rollup</h4>
        <p style={{ margin: '0 0 0.5rem 0', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
          {objectiveTitle}
          {hasOverride && ', override currently set'}
        </p>
        <p style={{ margin: '0 0 0.9rem 0', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
          Sets the level Schoology reports for this student. Writes back to Schoology immediately.
        </p>
        {suggest && (
          <button className="primary" disabled={saving} onClick={() => save(suggest)} style={{ marginBottom: '0.75rem' }}>
            Override Schoology to {suggest}
          </button>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginBottom: '0.75rem' }}>
          {LEVELS.map(lvl => {
            const c = LEVEL_COLORS[lvl];
            const active = currentLevel === lvl;
            return (
              <Tip
                as="button"
                key={lvl}
                text={LEVEL_LABELS[lvl]}
                disabled={saving}
                onClick={() => save(lvl)}
                style={{
                  padding: '0.4rem 0.7rem',
                  borderRadius: 6,
                  border: `2px solid ${active ? c.finalBorder : c.draftBorder}`,
                  background: c.headerFill, color: CELL_TEXT, fontWeight: 700,
                  cursor: saving ? 'wait' : 'pointer',
                  fontSize: '0.85rem',
                }}
              >
                {lvl}
              </Tip>
            );
          })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
          <button
            className="ghost"
            disabled={saving || !hasOverride}
            onClick={() => save(null)}
            style={{ fontSize: '0.78rem' }}
          >
            Clear override
          </button>
          <button
            className="ghost"
            disabled={saving}
            onClick={onClose}
            style={{ fontSize: '0.78rem' }}
          >
            Cancel
          </button>
        </div>
        {saving && (
          <p style={{ margin: '0.5rem 0 0 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            Writing to Schoology…
          </p>
        )}
        {error && !saving && <div className="alert alert-warning" role="alert" style={{ marginTop: '0.5rem' }}>{error}</div>}
      </div>
    </div>
  );
}
