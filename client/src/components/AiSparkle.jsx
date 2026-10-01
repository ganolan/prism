// The "AI suggestion" mark: a single four-point star with curved sides and
// rounded tips (the round-joined stroke softens each point). Replaced the
// 3-star glyph (client/src/assets/ai-sparkle.svg) in October 2026. Colour comes
// from CSS `color` (fill + stroke: currentColor), so callers set e.g.
// style={{ color: 'var(--ai-suggest)' }}. Decorative: always aria-hidden.
export default function AiSparkle({ size = 16, className, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}
         style={{ display: 'inline-block', verticalAlign: '-0.125em', flexShrink: 0, ...style }}
         aria-hidden="true" focusable="false">
      <path
        fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"
        d="M12 3 C12.6 8.2 15.8 11.4 21 12 C15.8 12.6 12.6 15.8 12 21 C11.4 15.8 8.2 12.6 3 12 C8.2 11.4 11.4 8.2 12 3 Z"
      />
    </svg>
  );
}
