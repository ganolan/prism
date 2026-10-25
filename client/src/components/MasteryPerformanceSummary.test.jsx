import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MasteryPerformanceSummary from './MasteryPerformanceSummary.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js', () => ({
  getMasteryForStudent: vi.fn(),
  getProficiencyScale: vi.fn(),
  writeMasteryOverride: vi.fn(),
}));

const LEVELS = [
  { code: 'ED', label: 'Exhibiting Depth', points: 100, gradeScaled: '87.50' },
  { code: 'EX', label: 'Exhibiting', points: 75, gradeScaled: '62.50' },
  { code: 'D', label: 'Developing', points: 50, gradeScaled: '37.50' },
  { code: 'EM', label: 'Emerging', points: 25, gradeScaled: '12.50' },
  { code: 'IE', label: 'Insufficient Evidence', points: 0, gradeScaled: '0.00' },
];

// One topic per category; `points` gives each category's score in order.
function mastery(points) {
  const topics = points.map((_, i) => ({
    id: `t${i}`, title: `Topic ${i}`, external_id: `X.${i}.1`, category_id: `c${i}`, category_title: `Category ${i}`, category_external_id: `X.${i}`,
  }));
  return {
    topics,
    alignments: topics.map((t) => ({ assignment_schoology_id: 'a1', assignment_title: 'Task', topic_id: t.id })),
    scores: points.map((p, i) => ({ topic_id: `t${i}`, assignment_schoology_id: 'a1', points: p })),
    rollups: [],
  };
}

function renderSummary() {
  return render(<MemoryRouter><MasteryPerformanceSummary courseId={1} studentUid="u1" courseName="Course" /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getProficiencyScale.mockResolvedValue({ levels: LEVELS, schoologyScaleId: 1 });
});

describe('MasteryPerformanceSummary letter grade', () => {
  it("shows HKIS's letter grade with the grade scale \"?\" (ED and EM in 2 categories is a C)", async () => {
    api.getMasteryForStudent.mockResolvedValue(mastery([100, 25]));
    renderSummary();
    expect(await screen.findByText('Letter grade:')).toBeInTheDocument();
    expect(screen.getByText('C')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /^HKIS letter grade, 2 reporting categories/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Letter Grade Scale/ })).toBeNull();
  });

  it('a course with one category shows no letter grade, and the "?" states why', async () => {
    api.getMasteryForStudent.mockResolvedValue(mastery([100]));
    renderSummary();
    expect(await screen.findByText('Letter grade:')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /^No letter grade: HKIS's letter grade chart covers 2 to 5 reporting categories, and this course has 1\.$/ }))
      .toBeInTheDocument();
  });
});

describe('MasteryPerformanceSummary category headers (#196)', () => {
  it('names each category by its short label, the full name on hover', async () => {
    const m = mastery([100, 75]);
    m.topics[0].category_title = 'HS Art: Producing';
    m.topics[1].category_title = 'HS Art: Creating, Responding, Connecting';
    api.getMasteryForStudent.mockResolvedValue(m);
    renderSummary();
    expect(await screen.findByRole('img', { name: 'Producing' })).toHaveTextContent('P');
    expect(screen.getByRole('img', { name: 'Creating, Responding, Connecting' })).toHaveTextContent('CRC');
    expect(screen.queryByText('HS Art: Producing')).toBeNull();
  });
});
