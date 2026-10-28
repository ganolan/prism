import { useEffect, useState } from 'react';
import PsAlertBadges, { TONE } from './PsAlertBadges.jsx';
import { AlertDetail } from './roster/AlertPopover.jsx';
import { Tip } from './HelpDot.jsx';
import { forRoster } from '../lib/psAlerts.js';
import { formatDate, formatDateTime } from '../lib/formatDate.js';
import { getAlertDetail } from '../services/api.js';

// The student page's PowerSchool alerts (#185, Graham chose option A on 28 Oct 2026). StudentPage draws
// this only with Private details on, which is the gate for what a projector may show.
//  - Learning, health and other alerts are chips in place, as on the roster (TONE colours). A chip opens
//    its detail under the chips, read live from PowerSchool (GET /api/students/:id/alert-detail/:key, the
//    roster pop-up's read; a learning alert answers with the Student Support Summary). One open at a time;
//    nothing is kept on the page.
//  - Family alerts (correspondence, divorced, staff child) and the do-not-contact and deceased guardians
//    (`extraCount`) stay behind one more click, Show family alerts (N), never remembered: `familyShown` lives
//    in StudentPage, shared with the guardian cards (#66), and is cleared when the student changes.
// See docs/design-language.md "PowerSchool alerts".

function DetailPanel({ studentId, alert, onClose }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let live = true;
    setState({ loading: true });
    getAlertDetail(studentId, alert.key)
      .then((detail) => { if (live) setState({ detail }); })
      .catch((err) => { if (live) setState({ error: err.message }); });
    return () => { live = false; };
  }, [studentId, alert.key]);
  return (
    <section className="student-alert-detail" id={`student-alert-${alert.key}`} aria-label={alert.title || alert.label}>
      <div className="student-alert-detail__head">
        <strong>{alert.title || alert.label}</strong>
        <button type="button" className="ghost" onClick={onClose}>Close</button>
      </div>
      {state.loading && <p className="text-sm text-muted">Reading from PowerSchool…</p>}
      {state.error && <p className="text-sm roster-pop__error">Could not read this alert: {state.error}</p>}
      {state.detail && (
        <>
          <AlertDetail detail={state.detail} />
          {state.detail.readAt && <p className="roster-pop__foot">From PowerSchool, read {formatDateTime(state.detail.readAt)}</p>}
        </>
      )}
    </section>
  );
}

export default function StudentAlerts({ studentId, alerts, syncedAt = null, familyShown, onFamilyShownChange, extraCount = 0 }) {
  const [openKey, setOpenKey] = useState(null);
  useEffect(() => { setOpenKey(null); }, [studentId]);
  const inPlace = forRoster(alerts);
  const family = (alerts || []).filter((a) => a.category === 'family');
  const familyCount = family.length + extraCount;
  if (!inPlace.length && familyCount <= 0) return null;
  const open = inPlace.find((a) => a.key === openKey) || null;
  const showsAlerts = inPlace.length > 0 || (familyShown && family.length > 0);

  return (
    <div className="student-alerts">
      <div className="student-alerts__chips">
        {inPlace.map((a) => (
          <Tip as="button" key={a.key} type="button" className={`badge ${TONE[a.category] || 'badge-gray'} student-alert-chip`}
            aria-expanded={openKey === a.key} aria-controls={openKey === a.key ? `student-alert-${a.key}` : undefined}
            aria-label={a.title || a.label} text={`${a.title || a.label}. Tap to read it from PowerSchool.`}
            onClick={() => setOpenKey(openKey === a.key ? null : a.key)}>
            {a.label}
          </Tip>
        ))}
        {familyCount > 0 && (familyShown ? (
          <>
            <PsAlertBadges alerts={family} syncedAt={syncedAt} />
            <button type="button" className="ghost ps-alerts-reveal" aria-expanded="true" onClick={() => onFamilyShownChange(false)}>
              Hide family alerts
            </button>
          </>
        ) : (
          <button type="button" className="ghost ps-alerts-reveal" aria-expanded="false" onClick={() => onFamilyShownChange(true)}>
            Show family alerts ({familyCount})
          </button>
        ))}
      </div>
      {open && <DetailPanel studentId={studentId} alert={open} onClose={() => setOpenKey(null)} />}
      {showsAlerts && syncedAt && <span className="text-sm text-muted">From PowerSchool, read {formatDate(syncedAt)}</span>}
    </div>
  );
}
