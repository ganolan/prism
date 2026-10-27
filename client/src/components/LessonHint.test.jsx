import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ExtendEditor from './triage/ExtendEditor.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js', () => ({ getLessonPlan: vi.fn() }));

// School days after the due date 06/10: 07, 09, 12, 13, 14 (08 a holiday); lessons 09, 13.
const PLAN = {
  from: '2026-10-06', today: '2026-10-06',
  days: ['2026-10-07', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14'].map((date, i) => ({ n: i + 1, date, approx: false })),
  meetings: ['2026-10-09', '2026-10-13'],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getLessonPlan.mockResolvedValue(PLAN);
});

describe('ExtendEditor lesson hint', () => {
  it('shows where the school-day count lands in the class\'s lessons, live as it changes', async () => {
    render(<ExtendEditor courseId={7} from="2026-10-06" extension={{ lessons: 3 }} onSave={() => {}} onCancel={() => {}} />);
    expect(await screen.findByTestId('lesson-hint')).toHaveTextContent('→ Mon 12/10 · 1 lesson from today');
    expect(api.getLessonPlan).toHaveBeenCalledWith(7, '2026-10-06', null);
    expect(screen.getByText('school days')).toBeInTheDocument();
  });

  it('"Next lesson" and "2 lessons" set the school-day count', async () => {
    const onSave = vi.fn();
    render(<ExtendEditor courseId={7} from="2026-10-06" extension={{ lessons: 1 }} onSave={onSave} onCancel={() => {}} showNote={false} />);
    fireEvent.click(await screen.findByRole('button', { name: '2 lessons' }));
    expect(screen.getByLabelText('Extension (school days)')).toHaveValue(4);
    expect(screen.getByTestId('lesson-hint')).toHaveTextContent('→ Tue 13/10 · 2 lessons from today');
    fireEvent.click(screen.getByRole('button', { name: 'Next lesson' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith(2, '', undefined);
  });

  it('an assignment extension past its due date offers From due date (default) or From today, and saves the choice', async () => {
    const onSave = vi.fn();
    render(<ExtendEditor courseId={7} from="2020-01-06" countFrom extension={null} onSave={onSave} onCancel={() => {}} />);
    expect(screen.getByRole('group', { name: 'Count the school days from' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'From due date Mon 06/01' })).toHaveAttribute('aria-pressed', 'true');
    expect(api.getLessonPlan).toHaveBeenCalledWith(7, '2020-01-06', 'due_date');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenLastCalledWith(3, '', 'due_date');
    fireEvent.click(screen.getByRole('button', { name: 'From today' }));
    expect(api.getLessonPlan).toHaveBeenLastCalledWith(7, '2020-01-06', 'today');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenLastCalledWith(3, '', 'today');
  });

  it('no count-from choice for a resubmission, or before the due date', () => {
    const { unmount } = render(<ExtendEditor courseId={7} from="2020-01-06" extension={null} onSave={() => {}} onCancel={() => {}} />);
    expect(screen.queryByRole('button', { name: 'From today' })).not.toBeInTheDocument();
    unmount();
    render(<ExtendEditor courseId={7} from="2999-01-06" countFrom extension={null} onSave={() => {}} onCancel={() => {}} />);
    expect(screen.queryByRole('button', { name: 'From today' })).not.toBeInTheDocument();
  });

  it('renders no hint without a course (or before the plan loads)', () => {
    render(<ExtendEditor extension={{ lessons: 3 }} onSave={() => {}} onCancel={() => {}} />);
    expect(screen.queryByTestId('lesson-hint')).not.toBeInTheDocument();
    expect(api.getLessonPlan).not.toHaveBeenCalled();
  });
});
