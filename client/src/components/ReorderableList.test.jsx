import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ReorderableList from './ReorderableList.jsx';

function setup(onReorder = vi.fn()) {
  const items = [
    { id: 'a', label: 'Alpha', content: 'Alpha' },
    { id: 'b', label: 'Bravo', content: 'Bravo' },
    { id: 'c', label: 'Charlie', content: 'Charlie' },
  ];
  render(<ReorderableList items={items} onReorder={onReorder} />);
  return onReorder;
}

describe('ReorderableList', () => {
  it('moves an item down via its ▼ button', () => {
    const onReorder = setup();
    fireEvent.click(screen.getByLabelText('Move Alpha down'));
    expect(onReorder).toHaveBeenCalledWith(['b', 'a', 'c']);
  });

  it('moves a focused item up with the ArrowUp key', () => {
    const onReorder = setup();
    fireEvent.keyDown(screen.getByText('Charlie').closest('li'), { key: 'ArrowUp' });
    expect(onReorder).toHaveBeenCalledWith(['a', 'c', 'b']);
  });

  it('reorders on drag and drop', () => {
    const onReorder = setup();
    const rows = screen.getAllByRole('listitem');
    fireEvent.dragStart(rows[2]);  // Charlie
    fireEvent.dragOver(rows[0]);   // over Alpha
    fireEvent.drop(rows[0]);
    expect(onReorder).toHaveBeenCalledWith(['c', 'a', 'b']);
  });

  it('highlights the drop target during a drag', () => {
    setup();
    const rows = screen.getAllByRole('listitem');
    fireEvent.dragStart(rows[2]);
    fireEvent.dragOver(rows[0]);
    expect(rows[0]).toHaveStyle({ boxShadow: 'inset 0 2px 0 0 var(--accent)' });
  });

  it('moves an item down past a lower target on drag-drop (insert after)', () => {
    const onReorder = setup();
    const rows = screen.getAllByRole('listitem');
    fireEvent.dragStart(rows[0]);  // Alpha
    fireEvent.dragOver(rows[2]);   // over Charlie
    fireEvent.drop(rows[2]);
    expect(onReorder).toHaveBeenCalledWith(['b', 'c', 'a']);
  });
});
