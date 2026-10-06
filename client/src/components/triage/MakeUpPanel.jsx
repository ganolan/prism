import { useState } from 'react';
import { Link } from 'react-router-dom';
import UrgencyRing from './UrgencyRing.jsx';
import CourseLine from './CourseLine.jsx';
import ExtendEditor, { ExtensionTag } from './ExtendEditor.jsx';
import { PanelHead, ShowAllToggle, useShowAll, limitRows } from './panelParts.jsx';
import { cardLink } from './ResubmissionsPanel.jsx';
import EmailMenu, { MailLink } from './EmailMenu.jsx';

// Students who missed a Schoology test or quiz and must sit it (or their * copy)
// ASAP, longest first. A row clears itself once an attempt syncs. Extend records
// when the make-up is booked ("sitting it Thursday"); the clock counts from then.
// Save hands off to the parent's StatusLineModal confirm, which publishes the
// make-up line (note included) to the student's Schoology comment.
// Day numbers: the test (or extended) date is day 1; red from day makeUpRedDay.
// The action column stacks Extend above "Ignore this test", which silences a whole
// test/quiz (all students) after an inline confirm below the row. Only one of the
// Extend editor / Ignore confirm is open per row.
// "@ ▾" (EmailMenu) copies still-owing students' addresses; ✉ (MailLink) on each row opens a mailto.
export default function MakeUpPanel({ rows, settings, showCourse, scope, unchecked = 0, ignored = 0, onExtend, onIgnore }) {
  const [extending, setExtending] = useState(null);
  const [confirmIgnore, setConfirmIgnore] = useState(null);
  const [showAll, toggleShowAll] = useShowAll(`makeUps.${scope}`);
  const red = settings.makeUpRedDay;
  const overdue = rows.filter((r) => r.tone === 'red').length;
  const key = (r) => `${r.studentId}:${r.assignmentId}`;

  return (
    <section className="card triage-panel" id="triage-makeups" aria-label="Make-up tests">
      <PanelHead title="Make-up tests" badge={overdue > 0 && <span className="badge badge-red">{overdue} overdue</span>}>
        <EmailMenu kind="makeUps" rows={rows} showCourse={showCourse} />
        <ShowAllToggle total={rows.length} showAll={showAll} onToggle={toggleShowAll} />
      </PanelHead>
      <p className="triage-panel__sub">test day = day 1 · sit by day {red - 1}</p>
      {unchecked > 0 && (
        <p className="alert alert-warning triage-panel__note">
          Couldn&apos;t check {unchecked} test{unchecked === 1 ? '' : 's'}: run a full sync.
        </p>
      )}
      {rows.length === 0 && <p className="text-sm text-muted">No missed tests.</p>}
      {ignored > 0 && (
        <p className="text-sm text-muted triage-panel__note">{ignored} test{ignored === 1 ? '' : 's'} ignored</p>
      )}
      {limitRows(rows, showAll).map((r) => {
        const k = key(r);
        const isExtending = extending === k;
        const isConfirming = confirmIgnore === k;
        return (
          <div key={k} className="triage-row">
            <UrgencyRing day={r.day} limit={red} tone={r.tone} approx={r.approx} size={28} />
            <div className="triage-row__text">
              <div className="triage-row__line">
                <Link to={cardLink(r)} className="triage-row__name" title={r.studentName}>{r.studentName}</Link>
                <MailLink row={r} kind="makeUps" />
                {r.extension && <ExtensionTag extension={r.extension} />}
              </div>
              {showCourse && <CourseLine row={r} />}
              <div className="triage-row__task" title={r.title}>{r.title}</div>
            </div>
            <div className="triage-row__actions">
              <button className="secondary btn-sm" onClick={() => { setConfirmIgnore(null); setExtending(isExtending ? null : k); }}>Extend</button>
              <button className="secondary btn-sm triage-row__quiet" onClick={() => { setExtending(null); setConfirmIgnore(isConfirming ? null : k); }}>Ignore this test</button>
            </div>
            {isExtending && (
              <div className="triage-row__more">
                <ExtendEditor
                  courseId={r.courseId} from={r.dueDate}
                  extension={r.extension}
                  onSave={(lessons, note) => { onExtend(r, lessons, note); setExtending(null); }}
                  onCancel={() => setExtending(null)}
                />
              </div>
            )}
            {isConfirming && (
              <div className="triage-row__more">
                <span className="text-sm">Ignore {r.title} for all students?</span>
                <button className="secondary danger btn-sm" onClick={() => { onIgnore(r); setConfirmIgnore(null); }}>Yes</button>
                <button className="ghost" onClick={() => setConfirmIgnore(null)}>Cancel</button>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
