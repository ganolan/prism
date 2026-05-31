import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import TriCheckbox from './TriCheckbox.jsx';

describe('TriCheckbox', () => {
  it('reflects the indeterminate visual via the DOM property', () => {
    const { getByRole } = render(<TriCheckbox checked={false} indeterminate={true} onChange={() => {}} />);
    expect(getByRole('checkbox').indeterminate).toBe(true);
  });
  it('is checked when checked and not indeterminate', () => {
    const { getByRole } = render(<TriCheckbox checked={true} indeterminate={false} onChange={() => {}} />);
    const el = getByRole('checkbox');
    expect(el.checked).toBe(true);
    expect(el.indeterminate).toBe(false);
  });
});
