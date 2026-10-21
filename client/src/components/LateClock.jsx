// The late mark (17/10/2026): Late qualifies a status, it is not a status of its own,
// and students often submit just after the deadline, so it is deliberately quiet.
//  - variant 'badge': a small red clock on the corner of a status pill (the pill needs
//    position: relative). Card header, student page, gradebook rubric modal.
//  - variant 'corner': a tiny muted-red clock in a gradebook cell's top-right corner (the
//    cell needs position: relative), so the status letter stays centred whether or not
//    the student was late; the comment marker is bottom right (layout A, 18/10/2026).
// This clock is the late *submission* only (Schoology's submission timing). The teacher's
// Late flag (Schoology exception 6) is a symbol of its own, FlagSymbol, in the grade's place (#40).
// `title` says how late on hover (lateText).
export default function LateClock({ variant = 'badge', title = 'Late' }) {
  return (
    <span className={`late-clock late-clock--${variant}`} role="img" aria-label={title} title={title}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
        <circle cx="8" cy="8" r="6" fill="none" /><path d="M8 4.5V8l2.4 1.6" />
      </svg>
    </span>
  );
}
