import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RecentTasks from './RecentTasks.jsx';

const task = (n, due, more = {}) => ({
  assignment_id: n, schoology_assignment_id: `sa-${n}`, assignment_title: `Task ${n}`, course_id: 1,
  due_date: due, exception: null, score: null, timeline: null, ...more,
});
const student = (grades) => ({ id: 7, first_name: 'Ana', courses: [{ id: 1, course_name: 'AP CSP' }], grades });
const renderList = (grades, props = {}) => render(<MemoryRouter><RecentTasks student={student(grades)} today="2026-10-28" {...props} /></MemoryRouter>);

describe('RecentTasks (#185)', () => {
  it('lists the last tasks due, newest first, linked to the task at this student, with the course and due date', () => {
    renderList([task(1, '2026-10-20'), task(2, '2026-10-27'), task(3, '2026-11-02')]);
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => within(li).getByRole('link').textContent)).toEqual(['Task 2', 'Task 1']);
    expect(within(items[0]).getByRole('link')).toHaveAttribute('href', '/course/1/assessment/sa-2?student=7');
    expect(within(items[0]).getByText('AP CSP, due 27/10')).toBeInTheDocument();
    expect(within(items[0]).getByText('Not graded yet')).toBeInTheDocument();
  });

  it('draws a flag as its symbol, and the status in its tone', () => {
    renderList([
      task(1, '2026-10-27', { exception: 3 }),
      task(2, '2026-10-26', { timeline: { submission: { state: 'not_started' }, overdue: { day: 12, overLimit: true } } }),
    ]);
    const [missing, over] = screen.getAllByRole('listitem');
    expect(within(missing).getByRole('img', { name: 'Missing' })).toBeInTheDocument();
    expect(within(missing).getByText('Missing')).toHaveClass('recent-task__status--over');
    expect(within(over).getByText('Not started (11 school days overdue, over the limit)')).toHaveClass('recent-task__status--over');
  });

  it('draws nothing when no task is due yet', () => {
    const { container } = renderList([task(1, '2026-11-02')]);
    expect(container).toBeEmptyDOMElement();
  });
});
