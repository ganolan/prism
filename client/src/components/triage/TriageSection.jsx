import { Fragment, useCallback, useEffect, useState } from 'react';
import { getTriage } from '../../services/api.js';
import { useDataVersion } from '../../hooks/useDataVersion.jsx';
import { useTriageActions } from '../../hooks/useTriageActions.js';
import LateWorkPanel from './LateWorkPanel.jsx';
import FeedbackOwedPanel from './FeedbackOwedPanel.jsx';
import MakeUpPanel from './MakeUpPanel.jsx';
import ResubmissionsPanel from './ResubmissionsPanel.jsx';
import UnfinishedGradingPanel from './UnfinishedGradingPanel.jsx';
import FlagsPanel from './FlagsPanel.jsx';
import { PrivateHidden } from '../PrivateDetails.jsx';
import { usePrivateDetails } from '../../lib/privateDetails.js';

// The triage rail: an <aside> of stacked panels, most urgent first (orderPanels):
// Unfinished grading on top whenever it has rows (quick fixes, a standing reminder),
// then the clocked panels by their most urgent row (red, then amber, then the rest),
// keeping the default order make-up tests, late work, resubmissions, flags (#174), feedback owed
// within a level — across all current courses (no courseId — Dashboard) or
// for one course (CoursePage). The page lays it out beside its main column (.triage-layout).
// Owns its fetch; onLoaded hands the payload up (the Dashboard uses it for
// course-card chips and the school-day header, the course page for the Gradebook
// tab's "Triage" count); onMakeUpIgnored(assignmentId) tells the course page a
// quiz was ignored; bumping `version` re-fetches in place (keeps Show formative
// and an open history). `hidden` hides the rail but keeps it mounted (and fetching).
// With Private details off (#197) the rail holds only the PrivateHidden box: no name, task or count is
// in the page. It still fetches, so the pages keep what is not private (the dashboard's school day).
// The row actions live in useTriageActions (shared with the Roster tab's Needs attention, #160):
// those that publish a status line to the student's Schoology comment (extensions,
// make-up extensions, resubmission Extend / Grade stands) open one StatusLineModal
// confirm here; nothing is written until Publish, and Cancel writes nothing.
// Unfinished grading first when it has rows; then panels with an overdue (red) row,
// then one nearing a limit (amber), then the rest; ties keep the given order.
const URGENCY = { red: 0, amber: 1 };
export function orderPanels(panels) {
  const level = (p) => {
    if (p.pinned) return p.rows.length > 0 ? -1 : 3;
    return Math.min(2, ...p.rows.map((r) => URGENCY[r.tone] ?? 2));
  };
  return panels.map((p, i) => ({ p, i, l: level(p) }))
    .sort((a, b) => a.l - b.l || a.i - b.i)
    .map(({ p }) => p);
}

// The page around it syncs from Schoology (background sync) and bumps `version` when a sync ends.
export default function TriageSection({ courseId = null, onLoaded, onMakeUpIgnored, version = 0, hidden = false, id }) {
  const dataVersion = useDataVersion();
  const [privateOn] = usePrivateDetails();
  const [data, setData] = useState(null);
  const [includeFormative, setIncludeFormative] = useState(undefined); // undefined → the Settings default
  const [showHistory, setShowHistory] = useState(false);
  const [showResubHistory, setShowResubHistory] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0); // reloads an open history after a record
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const t = await getTriage({ courseId, includeFormative });
      if (!t) return;
      setData(t);
      setError(null);
      onLoaded?.(t);
    } catch (err) {
      setError(err.message);
    }
  }, [courseId, includeFormative]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load, dataVersion, version]);

  // The row actions (Refer, Waive, Extend, Grade stands, Ignore) and their confirm: after each
  // write the lists refresh, with an open history.
  const actions = useTriageActions({
    onChanged: () => { setHistoryVersion((v) => v + 1); return load(); },
    onError: setError,
    onMakeUpIgnored,
  });

  const rail = (children) => (
    <aside className="triage triage-rail" aria-label="Triage" hidden={hidden} id={id}>{children}</aside>
  );
  if (!privateOn) return rail(<PrivateHidden title="Triage is private." />);
  if (!data && !error) return null;
  if (!data) return rail(<div className="alert alert-warning">Triage unavailable: {error}</div>);
  const showCourse = courseId == null;
  const scope = courseId ?? 'all';
  return rail(
    <>
      {error && <div className="alert alert-warning">{error}</div>}
      {orderPanels([
        {
          key: 'unfinished', rows: data.unfinishedGrading ?? [], pinned: true,
          el: <UnfinishedGradingPanel rows={data.unfinishedGrading ?? []} showCourse={showCourse} scope={scope} />,
        },
        {
          key: 'makeups', rows: data.makeUps ?? [],
          el: (
            <MakeUpPanel
              rows={data.makeUps ?? []} settings={data.settings} showCourse={showCourse} scope={scope}
              unchecked={data.makeUpsUnchecked ?? 0} ignored={data.makeUpsIgnored ?? 0}
              onExtend={actions.extendMakeUp} onIgnore={actions.ignore}
            />
          ),
        },
        {
          key: 'late', rows: data.lateWork,
          el: (
            <LateWorkPanel
              rows={data.lateWork} settings={data.settings} showCourse={showCourse} scope={scope}
              onRecord={actions.record} onRefer={actions.refer} onExtend={actions.extend}
              historyCount={data.historyCount}
              historyOpen={showHistory} onToggleHistory={() => setShowHistory((v) => !v)}
              courseId={courseId} historyVersion={historyVersion}
              onCloseHistory={() => setShowHistory(false)} onHistoryChanged={load}
            />
          ),
        },
        {
          key: 'resubmissions', rows: data.resubmissions ?? [],
          el: (
            <ResubmissionsPanel
              rows={data.resubmissions ?? []} settings={data.settings} showCourse={showCourse} scope={scope}
              onGradeStands={actions.gradeStands} onExtend={actions.extendResub}
              historyCount={data.resubmissionHistoryCount ?? 0}
              historyOpen={showResubHistory} onToggleHistory={() => setShowResubHistory((v) => !v)}
              courseId={courseId} historyVersion={historyVersion}
              onCloseHistory={() => setShowResubHistory(false)} onHistoryChanged={load}
            />
          ),
        },
        {
          key: 'flags', rows: data.flags ?? [],
          el: <FlagsPanel rows={data.flags ?? []} showCourse={showCourse} scope={scope} onChange={load} />,
        },
        {
          key: 'feedback', rows: data.feedbackOwed,
          el: (
            <FeedbackOwedPanel
              rows={data.feedbackOwed} settings={data.settings} showCourse={showCourse} scope={scope}
              includeFormative={data.includeFormative} onToggleFormative={setIncludeFormative}
            />
          ),
        },
      ]).map((p) => <Fragment key={p.key}>{p.el}</Fragment>)}
      {actions.modal}
    </>,
  );
}
