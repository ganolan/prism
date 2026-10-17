import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useStickyTypeFilter } from './useStickyTypeFilter.js';
import { DEFAULT_TYPE_FILTER } from '../lib/assessmentTypeFilter.js';

const STORAGE_KEY = 'prism.typeFilter.gradebook';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function FilterProbe() {
  const [filter, setFilter] = useStickyTypeFilter('gradebook');
  return (
    <div>
      <span data-testid="filter">{JSON.stringify(filter)}</span>
      <button onClick={() => setFilter({ ...filter, formative: false, unpublished: true })}>change</button>
    </div>
  );
}

const shown = () => JSON.parse(screen.getByTestId('filter').textContent);

describe('useStickyTypeFilter', () => {
  it('starts on the default filter when nothing is stored', () => {
    render(<FilterProbe />);
    expect(shown()).toEqual(DEFAULT_TYPE_FILTER);
  });

  it('survives a remount', () => {
    const first = render(<FilterProbe />);
    fireEvent.click(screen.getByText('change'));
    expect(shown()).toEqual({ summative: true, formative: false, unpublished: true });
    first.unmount();

    render(<FilterProbe />);
    expect(shown()).toEqual({ summative: true, formative: false, unpublished: true });
  });

  it('stores the filter in localStorage under one key', () => {
    render(<FilterProbe />);
    fireEvent.click(screen.getByText('change'));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)))
      .toEqual({ summative: true, formative: false, unpublished: true });
  });

  it('falls back to the default when the stored value is broken', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    render(<FilterProbe />);
    expect(shown()).toEqual(DEFAULT_TYPE_FILTER);
  });

  it('falls back to the default when the stored value has an unknown key', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...DEFAULT_TYPE_FILTER, quizzes: true }));
    render(<FilterProbe />);
    expect(shown()).toEqual(DEFAULT_TYPE_FILTER);
  });

  it('still works when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    render(<FilterProbe />);
    expect(shown()).toEqual(DEFAULT_TYPE_FILTER);
    fireEvent.click(screen.getByText('change'));
    expect(shown()).toEqual({ summative: true, formative: false, unpublished: true });
  });
});
