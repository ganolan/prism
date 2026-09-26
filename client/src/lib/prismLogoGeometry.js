// Prism's logo, measured from the concept art (client/src/assets/prism-logo-colour.png,
// 1536×1024) so the vector version keeps its composition. All coordinates are
// in the art's own pixels; PrismLogo.jsx and scripts/render-favicons.mjs use
// them directly as SVG viewBox units.
//
// The story: three separate streams arrive at very different angles, pass
// straight through the prism's front face, bend at its centre ridge, and
// converge on one point on the far face. They leave as a single beam, which
// becomes the wordmark's underline. This is deliberately not physics: the
// wide fan of angles is the point.

export const APEX = { x: 502, y: 284 };
export const BASE_Y = 666;
const TAN = 0.5638; // half-width / height, measured
export const BASE_LEFT = { x: APEX.x - (BASE_Y - APEX.y) * TAN, y: BASE_Y };
export const BASE_RIGHT = { x: APEX.x + (BASE_Y - APEX.y) * TAN, y: BASE_Y };
export const RIDGE_X = APEX.x; // the vertical front edge, where the beams bend

export const LEFT_X = 108; // where every beam is cut off, square
export const UNDERLINE = { y: 605, height: 17, endX: 1412 };
const exitY = UNDERLINE.y + UNDERLINE.height / 2;
export const EXIT = { x: APEX.x + (exitY - APEX.y) * TAN, y: exitY };
// Montserrat is broader than the art's face: sizes are ~7% down and the run is
// pinned to the art's width (P's stem at x=714 to M's edge at x=1412).
export const TEXT = { x: 697, baseline: 589, capSize: 239, smallSize: 208, length: 715 };

// Beam centre lines outside the glass, top to bottom (measured at x=112 and x=300).
export const BEAMS = [
  { colour: 'blue', y0: 310, slope: 0.473 },
  { colour: 'teal', y0: 473, slope: 0.125 },
  { colour: 'violet', y0: 646.5, slope: -0.253 },
];

// Vertical thickness: 54 at the left edge, 28 at the ridge (measured), and the
// underline's own thickness where they meet.
const THICK_LEFT = 54;
const THICK_RIDGE = 28;
const ENTRY_GAP = 14; // the beam stops this far short of the glass, as in the art
// The beam out starts this far clear of the far face, mirroring the way in, so
// it reads as leaving the glass rather than lying across its edge.
const EXIT_GAP = 14;

const lerp = (a, b, t) => a + (b - a) * t;
const leftFaceX = (y) => APEX.x - (y - APEX.y) * TAN;

// Where a straight edge y = y0 + m·(x − LEFT_X) meets the left face, shifted left by `gap`.
function hitFace(y0, m, gap = 0) {
  // x = APEX.x − (y − APEX.y)·TAN − gap  and  y = y0 + m·(x − LEFT_X)
  const x = (APEX.x - gap - (y0 - m * LEFT_X - APEX.y) * TAN) / (1 + m * TAN);
  return { x, y: y0 + m * (x - LEFT_X) };
}

/** weight scales every beam's thickness (the favicon draws them heavier). */
export function beamShapes({ weight = 1 } = {}) {
  const run = RIDGE_X - LEFT_X;
  return BEAMS.map(({ colour, y0, slope }) => {
    const cRidge = y0 + slope * run;
    const hl = (THICK_LEFT * weight) / 2;
    const hr = (THICK_RIDGE * weight) / 2;
    // The band's top and bottom edges are straight lines from the left cut to the ridge.
    const topM = (cRidge - hr - (y0 - hl)) / run;
    const botM = (cRidge + hr - (y0 + hl)) / run;
    const top0 = y0 - hl;
    const bot0 = y0 + hl;
    const outside = [
      { x: LEFT_X, y: top0 },
      hitFace(top0, topM, ENTRY_GAP),
      hitFace(bot0, botM, ENTRY_GAP),
      { x: LEFT_X, y: bot0 },
    ];
    const uh = (UNDERLINE.height * weight) / 2;
    const inside = [
      hitFace(top0, topM),
      { x: RIDGE_X, y: cRidge - hr },
      { x: EXIT.x, y: EXIT.y - uh },
      { x: EXIT.x, y: EXIT.y + uh },
      { x: RIDGE_X, y: cRidge + hr },
      hitFace(bot0, botM),
    ];
    return { colour, outside, inside, ridge: { x: RIDGE_X, y: cRidge }, entryY: lerp(top0, bot0, 0.5) };
  });
}

export const polygon = (pts) => `M${pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L')} Z`;
export const TRIANGLE = polygon([APEX, BASE_RIGHT, BASE_LEFT]);
export const SHADED_FACE = polygon([APEX, BASE_RIGHT, { x: RIDGE_X, y: BASE_Y }]);
const rightFaceX = (y) => APEX.x + (y - APEX.y) * TAN;

/**
 * The single beam out: from just clear of the far face (its left end cut
 * parallel to the face) to `endX`.
 */
export function exitBeam({ weight = 1, endX = UNDERLINE.endX } = {}) {
  const h = (UNDERLINE.height * weight) / 2;
  const top = EXIT.y - h;
  const bottom = EXIT.y + h;
  return [
    { x: rightFaceX(top) + EXIT_GAP, y: top },
    { x: endX, y: top },
    { x: endX, y: bottom },
    { x: rightFaceX(bottom) + EXIT_GAP, y: bottom },
  ];
}

export { leftFaceX, rightFaceX };
