import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import FeedbackPage from './FeedbackPage.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getFeedback).mockResolvedValue([]);
  vi.mocked(api.getGradingScales).mockResolvedValue({});
});

// #171: an excluded section (the template: no course code, no school code) is never read, so it
// has no feedback to filter by and stays off the course list.
describe('FeedbackPage course list', () => {
  it('leaves out excluded sections', async () => {
    vi.mocked(api.getCourses).mockResolvedValue([
      { id: 1, course_name: 'AP CSP', excluded: 0 },
      { id: 2, course_name: 'Template', excluded: 1 },
    ]);
    render(<MemoryRouter><FeedbackPage /></MemoryRouter>);
    expect(await screen.findByRole('option', { name: 'AP CSP' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Template' })).toBeNull();
  });
});
