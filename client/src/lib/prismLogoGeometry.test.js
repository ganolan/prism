import { describe, it, expect } from 'vitest';
import {
  APEX, BASE_LEFT, BASE_RIGHT, BEAMS, EXIT, RIDGE_X, TEXT, UNDERLINE, beamShapes, exitBeam, leftFaceX, rightFaceX,
} from './prismLogoGeometry.js';

const shapes = beamShapes();
const angle = (a, b) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
const mid = (p, q) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });

describe('Prism logo geometry (measured from the concept art)', () => {
  // The symbolism: separate streams arriving from very different directions.
  it('fans the three streams out widely, top to bottom blue, teal, violet', () => {
    expect(BEAMS.map((b) => b.colour)).toEqual(['blue', 'teal', 'violet']);
    const degs = BEAMS.map((b) => (Math.atan(b.slope) * 180) / Math.PI);
    expect(degs[0]).toBeGreaterThan(20); // blue falls
    expect(degs[2]).toBeLessThan(-10); // violet rises
    expect(degs[0] - degs[2]).toBeGreaterThan(35);
  });

  it('runs each beam straight through the front face: it bends at the ridge, not on entry', () => {
    for (const { colour, outside, inside } of shapes) {
      const outDir = angle(mid(outside[0], outside[3]), mid(outside[1], outside[2]));
      const toRidge = angle(mid(inside[0], inside[5]), mid(inside[1], inside[4]));
      const afterRidge = angle(mid(inside[1], inside[4]), mid(inside[2], inside[3]));
      expect(Math.abs(outDir - toRidge), `${colour} on entry`).toBeLessThan(1);
      expect(afterRidge - toRidge, `${colour} at the ridge`).toBeGreaterThan(3); // kinks downwards
      expect(inside[1].x).toBe(RIDGE_X);
    }
  });

  it('converges every beam on one exit point, on the far face, level with the underline', () => {
    for (const { inside } of shapes) expect(mid(inside[2], inside[3])).toEqual(EXIT);
    const onRightFace = (BASE_RIGHT.x - APEX.x) * (EXIT.y - APEX.y) - (BASE_RIGHT.y - APEX.y) * (EXIT.x - APEX.x);
    expect(onRightFace).toBeCloseTo(0, 6);
    expect(EXIT.y).toBe(UNDERLINE.y + UNDERLINE.height / 2);
  });

  it('stops each beam just short of the glass, and enters it on the left face', () => {
    for (const { outside, inside } of shapes) {
      for (const p of [outside[1], outside[2]]) expect(p.x).toBeLessThan(leftFaceX(p.y));
      for (const p of [inside[0], inside[5]]) expect(p.x).toBeCloseTo(leftFaceX(p.y), 6);
      expect(inside[0].y).toBeGreaterThan(APEX.y);
      expect(inside[5].y).toBeLessThan(BASE_LEFT.y);
    }
  });

  // Starting on the face would lay the beam across the glass's white edge.
  it('starts the beam out just clear of the far face, cut parallel to it', () => {
    const [top, , , bottom] = exitBeam();
    const clearance = (p) => p.x - rightFaceX(p.y);
    expect(clearance(top)).toBeGreaterThan(11 / 2); // wider than half the outline
    expect(clearance(bottom)).toBeCloseTo(clearance(top), 6);
    expect((top.y + bottom.y) / 2).toBe(EXIT.y);
  });

  it('ends the underline where the wordmark ends', () => {
    expect(TEXT.x + TEXT.length).toBe(UNDERLINE.endX);
    expect(exitBeam()[1].x).toBe(UNDERLINE.endX);
  });
});
