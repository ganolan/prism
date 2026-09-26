import { useId } from 'react';
import { tracePrism } from '../lib/prismOptics.js';

// Prism's identity: three coloured beams (the sources — Schoology, PowerSchool,
// your own notes) enter the prism and leave it as one beam, which runs on as
// the underline of the wordmark. The beam paths are ray-traced (see
// lib/prismOptics.js), not drawn by eye. The concept art is
// client/src/assets/prism-logo-colour.png; the favicon is generated from the
// same trace by scripts/render-favicons.mjs.
//
// Beam colours are the theme-independent --brand-* variables; the glass and the
// wordmark follow the --logo-* variables. See docs/design-language.md →
// "Logo & favicon".

const LEFT_EDGE = 2;
const { triangle, exit, beams } = tracePrism({ apex: { x: 66, y: 4 }, height: 50, exitY: 40, leftX: LEFT_EDGE });

const TEXT_X = 87; // just clear of the right face at the baseline
const TEXT_END = 189; // measured getBBox() end of "PRISM" in Montserrat 600
const VIEW_W = 192;
const VIEW_H = 66;
const BEAM_W = 5;
const UNDERLINE_W = 4.5;

const pt = (p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`;

// Extends a beam past the left cut, so the clip (not the line cap) squares it off.
function beyondEdge(start, entry, by = 6) {
  const slope = (start.y - entry.y) / (entry.x - start.x);
  return { x: start.x - by, y: start.y + by * slope };
}

export default function PrismLogo({ width = VIEW_W, className, title = 'Prism' }) {
  const id = useId();
  const clip = `${id}-clip`;
  const underline = `${id}-underline`;

  return (
    <svg
      className={className}
      width={width}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      role="img"
      aria-label={title}
      focusable="false"
    >
      <defs>
        <clipPath id={clip}>
          <rect x={LEFT_EDGE} y="0" width={VIEW_W - LEFT_EDGE} height={VIEW_H} />
        </clipPath>
        {/* Same order, top to bottom, as the beams that merge into it. */}
        <linearGradient id={underline} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" style={{ stopColor: 'var(--brand-teal)' }} />
          <stop offset="0.5" style={{ stopColor: 'var(--brand-blue)' }} />
          <stop offset="1" style={{ stopColor: 'var(--brand-violet)' }} />
        </linearGradient>
      </defs>

      <g clipPath={`url(#${clip})`} fill="none">
        {beams.map(({ colour, start, entry }) => (
          <g key={colour} data-beam={colour} style={{ stroke: `var(--brand-${colour})` }}>
            <path d={`M${pt(beyondEdge(start, entry))} L${pt(entry)}`} strokeWidth={BEAM_W} />
            {/* Inside the glass: fainter, converging on the exit point. */}
            <path d={`M${pt(entry)} L${pt(exit)}`} strokeWidth={BEAM_W * 0.7} strokeOpacity="0.6" />
          </g>
        ))}
      </g>

      <path
        d={`M${triangle.map(pt).join(' L')} Z`}
        strokeWidth="2"
        strokeLinejoin="round"
        style={{ fill: 'var(--logo-glass)', stroke: 'var(--logo-glass-edge)' }}
      />

      {/* The single beam out, which becomes the underline. */}
      <rect
        x={exit.x.toFixed(2)}
        y={(exit.y - UNDERLINE_W / 2).toFixed(2)}
        width={(TEXT_END - exit.x).toFixed(2)}
        height={UNDERLINE_W}
        fill={`url(#${underline})`}
      />

      <text
        x={TEXT_X}
        y="33"
        style={{ fill: 'var(--logo-text)', fontFamily: 'var(--logo-font)', fontWeight: 600, letterSpacing: '1.2px' }}
      >
        <tspan fontSize="34">P</tspan>
        <tspan fontSize="27">RISM</tspan>
      </text>
    </svg>
  );
}
