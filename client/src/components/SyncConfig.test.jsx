import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import SyncConfig from './SyncConfig.jsx';

const COURSES = [
  { id: 1, course_name: 'Biology 9', hidden: 0, archived: 0 },
  { id: 2, course_name: 'Chemistry 11', hidden: 0, archived: 0 },
  { id: 3, course_name: 'Old Physics', hidden: 1, archived: 0 },
  { id: 4, course_name: 'Archived Bio', hidden: 0, archived: 1 },
];

function renderConfig(props = {}) {
  return render(
    <SyncConfig
      courses={COURSES}
      loggedIn={true}
      busy={false}
      onStart={props.onStart || (() => {})}
      onCancel={props.onCancel || (() => {})}
      onLogin={props.onLogin || (() => {})}
    />
  );
}

describe('SyncConfig', () => {
  it('renders the three course groups with counts', () => {
    renderConfig();
    expect(screen.getByText(/Visible courses/)).toBeInTheDocument();
    expect(screen.getByText(/Hidden courses/)).toBeInTheDocument();
    expect(screen.getByText(/Archived courses/)).toBeInTheDocument();
  });

  it('shows visible courses expanded and others collapsed by default', () => {
    renderConfig();
    expect(screen.getByLabelText('Biology 9')).toBeInTheDocument();
    expect(screen.queryByLabelText('Old Physics')).not.toBeInTheDocument();
  });

  it('expands a collapsed group when its header is clicked', () => {
    renderConfig();
    fireEvent.click(screen.getByText(/Hidden courses/));
    expect(screen.getByLabelText('Old Physics')).toBeInTheDocument();
  });

  it('pre-selects all visible courses and starts with their ids', () => {
    const onStart = vi.fn();
    renderConfig({ onStart });
    fireEvent.click(screen.getByRole('button', { name: /start sync/i }));
    expect(onStart).toHaveBeenCalledWith([1, 2]);
  });

  it('group select-all checkbox is indeterminate when only some are selected', () => {
    renderConfig();
    fireEvent.click(screen.getByLabelText('Biology 9')); // deselect one
    const groupCheckbox = screen.getByLabelText(/select all visible/i);
    expect(groupCheckbox.indeterminate).toBe(true);
  });

  it('shows a login prompt instead of the course tree when not logged in', () => {
    render(
      <SyncConfig courses={COURSES} loggedIn={false} busy={false}
        onStart={() => {}} onCancel={() => {}} onLogin={() => {}} />
    );
    expect(screen.getByRole('button', { name: /log in to schoology/i })).toBeInTheDocument();
    expect(screen.queryByLabelText('Biology 9')).not.toBeInTheDocument();
  });
});
