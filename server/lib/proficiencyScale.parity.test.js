import { describe, test, expect } from 'vitest';
import { pointsToLevel, levelToPoints, levelToGradeScaled, levelToLabel, schoologyScaleId } from './proficiencyScale.js';

// The values as hardcoded TODAY (masterySync POINTS_TO_GRADE / GRADE_TO_LABEL /
// GRADING_SCALE_ID, AssessmentSummaryPage LEVEL_POINTS, OverridePopup SCALED_FOR_LEVEL).
const OLD_POINTS_TO_GRADE = { 100: 'ED', 75: 'EX', 50: 'D', 25: 'EM', 0: 'IE' };
const OLD_GRADE_TO_LABEL = { ED: 'Exhibiting Depth', EX: 'Exhibiting', D: 'Developing', EM: 'Emerging', IE: 'Insufficient Evidence' };
const OLD_LEVEL_POINTS = { ED: 100, EX: 75, D: 50, EM: 25, IE: 0 };
const OLD_SCALED_FOR_LEVEL = { ED: '87.50', EX: '62.50', D: '37.50', EM: '12.50', IE: '0.00' };

test('pointsToLevel matches old POINTS_TO_GRADE on the clean anchors', () => {
  for (const [points, code] of Object.entries(OLD_POINTS_TO_GRADE)) {
    expect(pointsToLevel(Number(points))).toBe(code);
  }
});

test('levelToPoints matches old LEVEL_POINTS', () => {
  for (const [code, points] of Object.entries(OLD_LEVEL_POINTS)) {
    expect(levelToPoints(code)).toBe(points);
  }
});

test('levelToGradeScaled matches old SCALED_FOR_LEVEL', () => {
  for (const [code, scaled] of Object.entries(OLD_SCALED_FOR_LEVEL)) {
    expect(levelToGradeScaled(code)).toBe(scaled);
  }
});

test('levelToLabel matches old GRADE_TO_LABEL', () => {
  for (const [code, label] of Object.entries(OLD_GRADE_TO_LABEL)) {
    expect(levelToLabel(code)).toBe(label);
  }
});

test('schoologyScaleId matches old GRADING_SCALE_ID', () => {
  expect(schoologyScaleId()).toBe(21337256);
});
