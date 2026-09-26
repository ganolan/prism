// Ray-traces Prism's logo, so the beams obey Snell's law instead of being
// drawn by eye. Shared by PrismLogo.jsx and scripts/render-favicons.mjs.
//
// Setup: an equilateral prism, apex up. One combined beam leaves the right
// face horizontally (it becomes the wordmark's underline). Traced backwards
// through each face, every colour's path follows from its refractive index.
// Light is always deviated towards the prism's base, so every beam going in
// rises from the lower left, and the higher the index, the steeper it rises.
// That makes violet the steepest, then blue, then teal: the reverse of a
// rainbow splitting out of a prism.
//
// The indices are exaggerated (real glass disperses by ~1°) so the three
// colours visibly separate.

const DEG = Math.PI / 180;
const HALF_APEX = 30 * DEG; // equilateral: each face leans 30° from vertical
const TAN = Math.tan(HALF_APEX);

export const BEAM_INDICES = { teal: 1.15, blue: 1.22, violet: 1.3 };

/**
 * apex: {x, y}; height: prism height; exitY: height of the outgoing beam
 * (on the right face); leftX: where the incoming beams are cut off.
 * Returns the triangle, the exit point, and each colour's start → entry → exit.
 */
export function tracePrism({ apex, height, exitY, leftX, indices = BEAM_INDICES }) {
  const half = height * TAN;
  const base = apex.y + height;
  const triangle = [apex, { x: apex.x + half, y: base }, { x: apex.x - half, y: base }];
  const exit = { x: apex.x + (exitY - apex.y) * TAN, y: exitY };

  const beams = Object.entries(indices).map(([colour, n]) => {
    // Right face: outside ray is horizontal, 30° from the face normal.
    const inside = Math.asin(Math.sin(HALF_APEX) / n); // angle to normal, inside
    const rise = HALF_APEX - inside; // inside ray climbs this much towards the exit

    // Walk back from the exit to the left face (x = apex.x - (y - apex.y)·tan30).
    const s = (exit.x - apex.x + (exit.y - apex.y) * TAN) / (Math.cos(rise) - TAN * Math.sin(rise));
    const entry = { x: exit.x - s * Math.cos(rise), y: exit.y + s * Math.sin(rise) };

    // Left face: the inside ray meets the normal at (60° − inside); refract out.
    const incidence = Math.asin(n * Math.sin(2 * HALF_APEX - inside));
    const climb = incidence - HALF_APEX; // the incoming beam's upward angle
    const start = { x: leftX, y: entry.y + (entry.x - leftX) * Math.tan(climb) };

    return { colour, n, start, entry, climbDeg: climb / DEG, riseDeg: rise / DEG };
  });

  return { triangle, exit, beams };
}
