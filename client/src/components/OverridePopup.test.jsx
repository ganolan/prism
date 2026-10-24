// OverridePopup: Schoology's per-(student, objective) override. With suggestedLevel (#160, the Roster
// tab's Mastery mode) Prism's level is offered first.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import OverridePopup from './OverridePopup.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js', () => ({ writeMasteryOverride: vi.fn() }));

const props = (extra = {}) => ({
  courseId: 5, studentUid: 'u1', objectiveId: 'c2', objectiveTitle: 'Annie Lee: 2 - Computational Thinking Practices',
  currentLevel: 'D', hasOverride: false, saving: false, setSaving: vi.fn(), onClose: vi.fn(), onSaved: vi.fn(), ...extra,
});

beforeEach(() => { vi.clearAllMocks(); api.writeMasteryOverride.mockResolvedValue({ ok: true }); });

describe('OverridePopup', () => {
  it('with a suggested level that differs, offers "Override Schoology to EX" first and writes it', async () => {
    const p = props({ suggestedLevel: 'EX' });
    render(<OverridePopup {...p} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).toHaveTextContent('Override Schoology to EX');
    expect(buttons[0]).toHaveClass('primary');
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(p.onClose).toHaveBeenCalled());
    expect(api.writeMasteryOverride).toHaveBeenCalledWith(5, { studentUid: 'u1', objectiveId: 'c2', level: 'EX' });
    expect(p.onSaved).toHaveBeenCalled();
  });

  it('offers no suggestion when there is none or it matches the current level', () => {
    const { rerender } = render(<OverridePopup {...props()} />);
    expect(screen.queryByText(/Override Schoology to/)).not.toBeInTheDocument();
    rerender(<OverridePopup {...props({ suggestedLevel: 'D' })} />);
    expect(screen.queryByText(/Override Schoology to/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear override' })).toBeDisabled();
  });
});
