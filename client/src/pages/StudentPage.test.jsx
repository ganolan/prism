import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FlagsCard } from './StudentPage.jsx';

function makeFlag(overrides = {}) {
  return {
    id: 1,
    flag_type: 'custom',
    flag_reason: 'Needs a chat',
    assignment_id: null,
    resolved: 0,
    created_at: '2026-05-01 10:00:00',
    ...overrides,
  };
}

function renderFlags(flags, handlers = {}) {
  return render(
    <FlagsCard
      flags={flags}
      assignmentLookup={{}}
      onAddFlag={handlers.onAddFlag || (() => {})}
      onResolveFlag={handlers.onResolveFlag || (() => {})}
      onReopenFlag={handlers.onReopenFlag || (() => {})}
      onDeleteFlag={handlers.onDeleteFlag || (() => {})}
    />
  );
}

describe('FlagsCard', () => {
  it('shows a Delete button on every flag row regardless of type', () => {
    renderFlags([
      makeFlag({ id: 1, flag_type: 'custom' }),
      makeFlag({ id: 2, flag_type: 'review_needed' }),
      makeFlag({ id: 3, flag_type: 'performance_change' }),
    ]);
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(3);
  });

  it('shows a Resolve button on an unresolved flag of any type', () => {
    renderFlags([makeFlag({ flag_type: 'review_needed', resolved: 0 })]);
    expect(screen.getByRole('button', { name: 'Resolve' })).toBeInTheDocument();
  });

  it('does not offer "Late Submission" as a flag type', () => {
    renderFlags([]);
    expect(
      screen.queryByRole('option', { name: 'Late Submission' })
    ).not.toBeInTheDocument();
  });

  it('adds a flag with the chosen type and reason', () => {
    const onAddFlag = vi.fn();
    renderFlags([], { onAddFlag });

    fireEvent.change(screen.getByPlaceholderText('Flag reason...'), {
      target: { value: 'check homework' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add Flag' }));

    expect(onAddFlag).toHaveBeenCalledWith('custom', 'check homework');
  });
});
