import { useId } from 'react';
import {
  BASE_Y, RIDGE_X, APEX, SHADED_FACE, TEXT, TRIANGLE,
  beamShapes, exitBeam, polygon,
} from '../lib/prismLogoGeometry.js';

// Prism's identity: three separate streams (Schoology, PowerSchool, your own
// notes) arrive at very different angles, bend at the prism's centre ridge and
// converge, then leave as one beam, which runs on as the wordmark's underline.
// Geometry is measured from the concept art (client/src/assets/prism-logo-colour.png)
// and lives in lib/prismLogoGeometry.js, in the art's own pixel coordinates.
// The favicon is generated from the same geometry by scripts/render-favicons.mjs.
//
// Beam colours are the theme-independent --brand-* variables; the glass and the
// wordmark follow the --logo-* variables. See docs/design-language.md →
// "Logo & favicon".

const VIEW = { x: 100, y: 270, w: 1320, h: 410 };
const BEAMS = beamShapes();
const EXIT_BEAM = exitBeam();

export default function PrismLogo({ width = 196, className, title = 'Prism' }) {
  const underline = `${useId()}-underline`;

  return (
    <svg
      className={className}
      width={width}
      viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`}
      role="img"
      aria-label={title}
      focusable="false"
    >
      <defs>
        <linearGradient id={underline} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" style={{ stopColor: 'var(--brand-blue)' }} />
          <stop offset="0.45" style={{ stopColor: 'var(--brand-teal)' }} />
          <stop offset="1" style={{ stopColor: 'var(--brand-violet)' }} />
        </linearGradient>
      </defs>

      {BEAMS.map(({ colour, outside, inside }) => (
        <g key={colour} data-beam={colour} style={{ fill: `var(--brand-${colour})` }}>
          <path d={polygon(outside)} />
          {/* Seen through the glass: paler. */}
          <path d={polygon(inside)} fillOpacity="0.6" />
        </g>
      ))}

      <path d={TRIANGLE} style={{ fill: 'var(--logo-glass)' }} />
      <path d={SHADED_FACE} style={{ fill: 'var(--logo-glass-shade)' }} />
      <line
        x1={RIDGE_X} y1={APEX.y} x2={RIDGE_X} y2={BASE_Y}
        strokeWidth="6"
        strokeOpacity="0.6"
        style={{ stroke: 'var(--logo-glass-edge)' }}
      />
      <path d={TRIANGLE} fill="none" strokeWidth="11" strokeLinejoin="round" style={{ stroke: 'var(--logo-glass-edge)' }} />

      {/* The one beam out, which becomes the underline. */}
      <path d={polygon(EXIT_BEAM)} fill={`url(#${underline})`} />

      <text
        x={TEXT.x}
        y={TEXT.baseline}
        textLength={TEXT.length}
        lengthAdjust="spacing"
        style={{ fill: 'var(--logo-text)', fontFamily: 'var(--logo-font)', fontWeight: 600 }}
      >
        <tspan fontSize={TEXT.capSize}>P</tspan>
        <tspan fontSize={TEXT.smallSize}>RISM</tspan>
      </text>
    </svg>
  );
}
