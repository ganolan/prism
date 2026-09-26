import { useId } from 'react';

// Prism's identity: three coloured beams (the sources — Schoology, PowerSchool,
// your own notes) enter the prism and leave it as one beam, which runs on as
// the underline of the wordmark. Vector rebuild of
// client/src/assets/prism-logo-colour.png; the favicon (client/public/favicon.svg)
// is the same mark, simplified for 16px.
//
// Beam colours are the theme-independent --brand-* variables; the glass and the
// wordmark follow --logo-glass / --logo-text so the lockup reads on every
// theme's sidebar. See docs/design-language.md → "Logo & favicon".

// Triangle: apex (44,6), base (18,54)–(70,54). Every beam converges on EXIT,
// a point on the right face level with the underline.
const EXIT = { x: 65.67, y: 46 };
const BEAMS = [
  { colour: 'var(--brand-blue)', from: [-10, 4], entry: [34.25, 24] },
  { colour: 'var(--brand-teal)', from: [-10, 28], entry: [29.38, 33] },
  { colour: 'var(--brand-violet)', from: [-10, 52], entry: [24.5, 42] },
];

export default function PrismLogo({ width = 182, className, title = 'Prism' }) {
  const id = useId();
  const clip = `${id}-clip`;
  const underline = `${id}-underline`;

  return (
    <svg
      className={className}
      width={width}
      viewBox="0 0 182 60"
      role="img"
      aria-label={title}
      focusable="false"
    >
      <defs>
        {/* Squares every beam off at the same left edge. */}
        <clipPath id={clip}>
          <rect x="2" y="0" width="180" height="60" />
        </clipPath>
        <linearGradient id={underline} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" style={{ stopColor: 'var(--brand-blue)' }} />
          <stop offset="0.5" style={{ stopColor: 'var(--brand-teal)' }} />
          <stop offset="1" style={{ stopColor: 'var(--brand-violet)' }} />
        </linearGradient>
      </defs>

      <g clipPath={`url(#${clip})`} fill="none" strokeWidth="4.5" strokeLinejoin="round">
        {BEAMS.map(({ colour, from, entry }) => (
          <g key={colour} style={{ stroke: colour }}>
            <line x1={from[0]} y1={from[1]} x2={entry[0]} y2={entry[1]} />
            {/* Inside the glass: fainter, and narrowing to the exit point. */}
            <line x1={entry[0]} y1={entry[1]} x2={EXIT.x} y2={EXIT.y} strokeOpacity="0.55" strokeWidth="3" />
          </g>
        ))}
      </g>

      <path
        d="M44 6 L70 54 L18 54 Z"
        strokeWidth="1.75"
        strokeLinejoin="round"
        style={{ fill: 'var(--logo-glass)', stroke: 'var(--logo-glass-edge)' }}
      />

      {/* The single beam out, which becomes the underline. */}
      <path d={`M${EXIT.x} ${EXIT.y - 1.75} H178 V${EXIT.y + 1.75} H${EXIT.x + 1.9} Z`} fill={`url(#${underline})`} />

      <text
        x="77"
        y="39"
        style={{ fill: 'var(--logo-text)', fontFamily: 'var(--logo-font)', fontWeight: 600, letterSpacing: '1.2px' }}
      >
        <tspan fontSize="34">P</tspan>
        <tspan fontSize="27">RISM</tspan>
      </text>
    </svg>
  );
}
