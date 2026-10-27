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

  // #188: the server refuses when Schoology changed, and checks its read-back; the pop-up says why, stays
  // open, and re-reads the levels Prism stored from Schoology.
  it('a refusal shows in the pop-up, which stays open; CHANGED re-reads the levels, a plain failure does not', async () => {
    const p = props({ suggestedLevel: 'EX' });
    api.writeMasteryOverride.mockRejectedValueOnce(Object.assign(new Error("Schoology's level changed since Prism last read it (now EX). Nothing was written: look at it again before overriding."), { code: 'CHANGED' }));
    const { rerender } = render(<OverridePopup {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Override Schoology to EX' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Schoology's level changed since Prism last read it");
    expect(p.onSaved).toHaveBeenCalledTimes(1);
    expect(p.onClose).not.toHaveBeenCalled();
    api.writeMasteryOverride.mockRejectedValueOnce(new Error('Request failed: 500'));
    rerender(<OverridePopup {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Override Schoology to EX' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Request failed: 500'));
    expect(p.onSaved).toHaveBeenCalledTimes(1);
    expect(p.onClose).not.toHaveBeenCalled();
  });
});
