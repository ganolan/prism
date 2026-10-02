import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import UrgencyRing from './UrgencyRing.jsx';
import CourseLine from './CourseLine.jsx';
import ExtendEditor, { ExtensionTag } from './ExtendEditor.jsx';
import { PanelHead, ShowAllToggle, RowToggle, useShowAll, useOpenRows, limitRows, moreId } from './panelParts.jsx';

// Students who missed a Schoology test or quiz and must sit it (or their * copy)
// ASAP, longest first. A row clears itself once an attempt syncs. Extend records
// when the make-up is booked ("sitting it Thursday"); the clock counts from then.
// Day numbers: the test (or extended) date is day 1; red from day makeUpRedDay.
// Each row expands (▾) to Extend and "Ignore this test", which silences a whole
// test/quiz (all students) after an inline confirm.
export default function MakeUpPanel({ rows, settings, showCourse, scope, unchecked = 0, ignored = 0, onExtend, onIgnore }) {
  const panelId = useId();
  const [extending, setExtending] = useState(null);
  const [confirmIgnore, setConfirmIgnore] = useState(null);
  const [showAll, toggleShowAll] = useShowAll(`makeUps.${scope}`);
  const [isOpen, toggleOpen] = useOpenRows();
  const red = settings.makeUpRedDay;
  const overdue = rows.filter((r) => r.tone === 'red').length;
  const key = (r) => `${r.studentId}:${r.assignmentId}`;

  return (
    <section className="card triage-panel" aria-label="Make-up tests">
      <PanelHead title="Make-up tests" badge={overdue > 0 && <span className="badge badge-red">{overdue} overdue</span>}>
        <ShowAllToggle total={rows.length} showAll={showAll} onToggle={toggleShowAll} />
      </PanelHead>
      <p className="triage-panel__sub">test day = day 1 · sit by day {red - 1}</p>
      {unchecked > 0 && (
        <p className="alert alert-warning triage-panel__note">
          Couldn&apos;t check {unchecked} test{unchecked === 1 ? '' : 's'} — run a full sync.
        </p>
      )}
      {rows.length === 0 && <p className="text-sm text-muted">No missed tests.</p>}
      {ignored > 0 && (
        <p className="text-sm text-muted triage-panel__note">{ignored} test{ignored === 1 ? '' : 's'} ignored</p>
      )}
      {limitRows(rows, showAll).map((r) => {
        const k = key(r);
        const open = isOpen(k);
        return (
          <div key={k} className={`triage-row${open ? ' is-open' : ''}`}>
            <UrgencyRing day={r.day} limit={red} tone={r.tone} approx={r.approx} size={28} />
            <div className="triage-row__text">
              <div className="triage-row__line">
                <Link to={`/student/${r.studentId}`} className="triage-row__name" title={r.studentName}>{r.studentName}</Link>
                {r.extension && <ExtensionTag extension={r.extension} />}
              </div>
              {showCourse && <CourseLine row={r} />}
              <div className="triage-row__task" title={r.title}>{r.title}</div>
            </div>
            <div className="triage-row__actions">
              <RowToggle label={`${r.studentName}, ${r.title}`} expanded={open} controls={moreId(panelId, k)} onToggle={() => toggleOpen(k)} />
            </div>
            {open && (
              <div className="triage-row__more" id={moreId(panelId, k)}>
                {confirmIgnore !== k && extending !== k && (
                  <>
                    <button className="secondary btn-sm" onClick={() => { setConfirmIgnore(null); setExtending(k); }}>Extend</button>
                    <button className="secondary btn-sm triage-row__quiet" onClick={() => { setExtending(null); setConfirmIgnore(k); }}>Ignore this test</button>
                  </>
                )}
                {confirmIgnore === k && (
                  <>
                    <span className="text-sm">Ignore {r.title} for all students?</span>
                    <button className="secondary danger btn-sm" onClick={() => { onIgnore(r); setConfirmIgnore(null); }}>Yes</button>
                    <button className="ghost" onClick={() => setConfirmIgnore(null)}>Cancel</button>
                  </>
                )}
                {extending === k && (
                  <ExtendEditor
                    extension={r.extension}
                    onSave={(lessons, note) => { onExtend(r, lessons, note); setExtending(null); }}
                    onCancel={() => setExtending(null)}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
