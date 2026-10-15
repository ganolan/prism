// What the last "Load results" could not do cleanly, for both tabs of the assessment page.
// Reads the group's stored parity result and load summary; renders nothing when all is well.
export default function QuizLoadWarnings({ group, students = [] }) {
  if (!group) return null;
  const summary = group.load_summary || {};
  const nameByUid = new Map(students.map((s) => [String(s.schoology_uid), [s.first_name, s.last_name].filter(Boolean).join(' ')]));
  const who = (uid) => (uid == null ? null : nameByUid.get(String(uid)) || `Schoology user ${uid}`);

  const lines = [];
  if (group.parity_status === 'mismatch' && group.parity_detail?.length) {
    lines.push({
      key: 'parity',
      text: 'The combined tests differ:',
      items: group.parity_detail,
    });
  }
  const failed = summary.failed || [];
  if (failed.length) {
    lines.push({
      key: 'failed',
      text: `${failed.length} ${failed.length === 1 ? 'student' : 'students'} could not be loaded:`,
      items: failed.map((f) => (f.uid == null ? f.reason : `${who(f.uid)}: ${f.reason}`)),
    });
  }
  const unknown = summary.unknownUids || [];
  if (unknown.length) {
    lines.push({
      key: 'unknown',
      text: `${unknown.length} ${unknown.length === 1 ? 'student' : 'students'} Prism does not know. Sync the course, then load again.`,
    });
  }
  const multiple = summary.multipleAttempts || [];
  if (multiple.length) {
    lines.push({
      key: 'multiple',
      text: `${multiple.length} ${multiple.length === 1 ? 'student has' : 'students have'} more than one attempt. Prism used the latest.`,
    });
  }
  if (!lines.length) return null;

  return (
    <div className="alert alert-warning" role="status" data-testid="quiz-load-warnings"
      style={{ margin: '0.5rem 0 0', padding: '0.5rem 0.8rem', fontSize: '0.82rem' }}>
      {lines.map((l) => (
        <div key={l.key}>
          {l.text}
          {l.items && (
            <ul style={{ margin: '0.15rem 0 0.25rem', paddingLeft: '1.1rem' }}>
              {l.items.map((t, i) => <li key={i}>{t}</li>)}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
