// A compact "open this in Schoology" affordance: an external-link glyph with an
// optional visible label, linking out to a Schoology `web_url`. Renders nothing
// when no url is available — Schoology omits `web_url` on some assignments, so
// callers can pass it through unconditionally. Always opens in a new tab with
// rel="noopener noreferrer" (the safe external-link combo); inherits its colour
// from the `.link` class so it tracks the active theme.
export default function SchoologyLink({ url, label, ariaLabel, size = 14, style }) {
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="link"
      // When there's a visible label the label IS the accessible name; icon-only
      // links carry the name on aria-label instead.
      aria-label={label ? undefined : (ariaLabel || 'View in Schoology')}
      title={ariaLabel || label || 'View in Schoology'}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', flexShrink: 0, ...style }}
    >
      <ExternalLinkIcon size={size} />
      {label && <span>{label}</span>}
    </a>
  );
}

function ExternalLinkIcon({ size = 14 }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}
