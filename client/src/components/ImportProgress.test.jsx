import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ImportProgress from './ImportProgress.jsx';

const runningModel = {
  status: 'running', total: 2, done: 1, progress: 0.5,
  rows: [
    { sectionId: 's1', title: 'Robotics', status: 'done', counts: { students: 20, grades: 100 } },
    { sectionId: 's2', title: 'Drama', status: 'running' },
  ],
  log: ['Imported Robotics (20 students, 100 grades)'],
  failures: [],
};

const doneWithFailure = {
  status: 'done', total: 2, done: 2, progress: 1,
  rows: [
    { sectionId: 's1', title: 'Robotics', status: 'done', counts: { students: 20, grades: 100 } },
    { sectionId: 's2', title: 'PCG', status: 'error', error: 'not accessible (403)' },
  ],
  log: ['Imported Robotics (20 students, 100 grades)', 'PCG failed: not accessible (403)'],
  failures: [{ sectionId: 's2', title: 'PCG', error: 'not accessible (403)' }],
};

describe('ImportProgress', () => {
  it('shows progress and disables Done while running', () => {
    render(<ImportProgress model={runningModel} onRetry={() => {}} onDone={() => {}} />);
    expect(screen.getByText(/Importing archived courses/)).toBeInTheDocument();
    expect(screen.getByText(/Please don't close Prism/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /done/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /retry failed/i })).not.toBeInTheDocument();
  });

  it('summarises completion with a failure and offers Retry failed', () => {
    const onRetry = vi.fn();
    render(<ImportProgress model={doneWithFailure} onRetry={onRetry} onDone={() => {}} />);
    expect(screen.getByText(/Import complete · 1 of 2/)).toBeInTheDocument();
    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
    expect(screen.getByText(/not accessible \(403\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry failed \(1\)/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('enables Done and hides Retry when all succeed', () => {
    const onDone = vi.fn();
    const allOk = {
      status: 'done', total: 1, done: 1, progress: 1,
      rows: [{ sectionId: 's1', title: 'Robotics', status: 'done', counts: { students: 1, grades: 1 } }],
      log: ['Imported Robotics (1 students, 1 grades)'], failures: [],
    };
    render(<ImportProgress model={allOk} onRetry={() => {}} onDone={onDone} />);
    expect(screen.getByText(/Import complete · 1 of 1/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry failed/i })).not.toBeInTheDocument();
    const done = screen.getByRole('button', { name: /done/i });
    expect(done).not.toBeDisabled();
    fireEvent.click(done);
    expect(onDone).toHaveBeenCalled();
  });
});
