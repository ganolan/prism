import { describe, it, expect } from 'vitest';
import { tracePrism, BEAM_INDICES } from './prismOptics.js';

const geometry = tracePrism({ apex: { x: 66, y: 4 }, height: 50, exitY: 40, leftX: 2 });
const { triangle, exit, beams } = geometry;
const [apex, baseRight, baseLeft] = triangle;

const unit = (from, to) => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  return { x: dx / len, y: dy / len };
};
// Sine of the angle between a ray and a face (via its normal): |ray × face| = cos(angle to face) = sin(angle to normal).
const sinToNormal = (ray, faceDir) => Math.abs(ray.x * faceDir.x + ray.y * faceDir.y);

const leftFace = unit(baseLeft, apex);
const rightFace = unit(apex, baseRight);
const OUT = { x: 1, y: 0 }; // the outgoing beam, i.e. the underline

describe('tracePrism', () => {
  it('draws an equilateral prism, apex up', () => {
    const side = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    expect(side(apex, baseLeft)).toBeCloseTo(side(apex, baseRight), 6);
    expect(side(baseLeft, baseRight)).toBeCloseTo(side(apex, baseRight), 6);
    expect(apex.y).toBeLessThan(baseLeft.y);
  });

  it('puts the exit on the right face, and each entry on the left face', () => {
    const onLine = (p, a, b) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    expect(onLine(exit, apex, baseRight)).toBeCloseTo(0, 6);
    for (const { entry } of beams) {
      expect(onLine(entry, baseLeft, apex)).toBeCloseTo(0, 6);
      expect(entry.y).toBeGreaterThan(apex.y);
      expect(entry.y).toBeLessThan(baseLeft.y);
    }
  });

  // n₁·sin θ₁ = n₂·sin θ₂ at both faces, with air n = 1.
  it("obeys Snell's law where each beam enters and leaves the glass", () => {
    for (const { n, start, entry } of beams) {
      const incoming = unit(start, entry);
      const inside = unit(entry, exit);
      expect(sinToNormal(incoming, leftFace)).toBeCloseTo(n * sinToNormal(inside, leftFace), 6);
      expect(sinToNormal(OUT, rightFace)).toBeCloseTo(n * sinToNormal(inside, rightFace), 6);
    }
  });

  // Deviation is always towards the base, so for a horizontal exit every beam
  // must come up from below — and the denser the glass, the steeper it climbs.
  it('brings every beam up from below, steepest for the highest index', () => {
    const byIndex = [...beams].sort((a, b) => a.n - b.n);
    for (const b of byIndex) expect(b.climbDeg).toBeGreaterThan(0);
    const climbs = byIndex.map((b) => b.climbDeg);
    expect(climbs).toEqual([...climbs].sort((a, b) => a - b));
    expect(byIndex.map((b) => b.colour)).toEqual(['teal', 'blue', 'violet']);
    expect(Object.keys(BEAM_INDICES)).toHaveLength(3);
  });

  it('keeps the colours from crossing: top to bottom they stay teal, blue, violet', () => {
    const order = (key) => [...beams].sort((a, b) => a[key].y - b[key].y).map((b) => b.colour);
    expect(order('start')).toEqual(['teal', 'blue', 'violet']);
    expect(order('entry')).toEqual(['teal', 'blue', 'violet']);
  });
});
