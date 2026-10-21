// The late mark (17/10/2026): Late qualifies a status, it is not a status of its own,
// and students often submit just after the deadline, so it is deliberately quiet.
//  - variant 'badge': a small red clock on the corner of a status pill (the pill needs
//    position: relative). Card header, student page, gradebook rubric modal.
//  - variant 'corner': a tiny muted-red clock in a gradebook cell's top-right corner (the
//    cell needs position: relative), so the status letter stays centred whether or not
//    the student was late; the comment marker is bottom right (layout A, 18/10/2026).
// Two sources, two clocks (#40): the outline clock is a late submission; `flagged` is the
// teacher's Late flag, the same clock as a solid disc with light hands. Both read as "late",
// the fill marks the one a teacher set. With both, the flagged one shows.
// `title` says why on hover (lateText).
export default function LateClock({ variant = 'badge', flagged = false, title = 'Late' }) {
  return (
    <span className={`late-clock late-clock--${variant}${flagged ? ' late-clock--flagged' : ''}`} role="img" aria-label={title} title={title}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
        <circle cx="8" cy="8" r="6" fill={flagged ? 'currentColor' : 'none'} /><path d="M8 4.5V8l2.4 1.6" />
      </svg>
    </span>
  );
}
