// Shows that tests are combined (and linked to a result task) wherever the
// canonical assignment is listed.
export default function QuizChip({ group }) {
  if (!group) return null;
  const tests = group.members.map(m => m.title).join(', ');
  return (
    <span className="badge" title={group.result ? `Result task: ${group.result.title}` : 'Combined tests, not linked to a result task'}
      style={{ fontSize: '0.68rem' }}>
      {group.result ? `Linked: ${tests}` : `Combined: ${tests}`}
    </span>
  );
}
