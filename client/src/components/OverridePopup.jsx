import { writeMasteryOverride } from '../services/api.js';
import { LEVELS, LEVEL_LABELS, LEVEL_COLORS, CELL_TEXT } from '../lib/masteryLevels.js';

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
 *   saving, setSaving, onClose, onSaved
 */
export default function OverridePopup({
  courseId, studentUid, objectiveId, objectiveTitle,
  currentLevel, hasOverride,
  saving, setSaving, onClose, onSaved,
}) {
  async function save(level) {
    setSaving(true);
    try {
      await writeMasteryOverride(courseId, { studentUid, objectiveId, level });
      await onSaved?.();
      onClose();
    } catch (err) {
      alert(`Failed to save override: ${err.message}`);
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
          {hasOverride && ' — override currently set'}
        </p>
        <p style={{ margin: '0 0 0.9rem 0', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
          Sets the level Schoology reports for this student. Writes back to Schoology immediately.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginBottom: '0.75rem' }}>
          {LEVELS.map(lvl => {
            const c = LEVEL_COLORS[lvl];
            const active = currentLevel === lvl;
            return (
              <button
                key={lvl}
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
                title={LEVEL_LABELS[lvl]}
              >
                {lvl}
              </button>
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
      </div>
    </div>
  );
}
