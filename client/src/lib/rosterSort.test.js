import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { sortRoster, getRosterSort, setRosterSort, effectiveSort, ROSTER_SORTS } from './rosterSort.js';

const s = (id, first, last, extra = {}) => ({ id, first_name: first, last_name: last, ...extra });
const ids = (list) => list.map((x) => x.id);

describe('sortRoster', () => {
  const list = [
    s(1, 'Ana', 'Lee', { preferred_name: 'Zed' }), // shown as Zed Lee
    s(2, 'Bo', 'Adams'),
    s(3, 'Cy', 'Lee'),
    s(4, 'Bo', 'Zhang'),
  ];

  it('last name uses the name the card shows; ties break on the first name', () => {
    expect(ids(sortRoster(list, 'last'))).toEqual([2, 3, 1, 4]);
  });

  it('first name uses the preferred name; ties break on the last name', () => {
    expect(ids(sortRoster(list, 'first'))).toEqual([2, 4, 3, 1]);
  });

  it('gender: F, M, NB, ?, then last name', () => {
    const g = [
      s(1, 'A', 'Zulu', { gender: 'M' }),
      s(2, 'B', 'Yankee', { gender: null }),
      s(3, 'C', 'Xray', { gender: 'F' }),
      s(4, 'D', 'Alpha', { gender: 'M' }),
      s(5, 'E', 'Beta', { gender: 'F' }),
      s(6, 'F', 'Gamma', { gender: 'X' }),
      s(7, 'G', 'Delta', { gender: 'N' }),
      s(8, 'H', 'Omega', {}),
    ];
    // F (Beta, Xray), M (Alpha, Zulu), NB (Delta, Gamma), ? (Omega, Yankee)
    expect(ids(sortRoster(g, 'gender'))).toEqual([5, 3, 4, 1, 7, 6, 8, 2]);
  });

  it('does not change the list it is given', () => {
    const copy = [...list];
    sortRoster(list, 'first');
    expect(list).toEqual(copy);
  });

  it('ignores case and accents', () => {
    expect(ids(sortRoster([s(1, 'a', 'zeta'), s(2, 'b', 'Álvarez'), s(3, 'c', 'beta')], 'last'))).toEqual([2, 3, 1]);
  });
});

describe('the remembered sort', () => {
  beforeEach(() => { localStorage.clear(); setRosterSort('last'); localStorage.clear(); });
  afterEach(() => vi.restoreAllMocks());

  it('defaults to last name and offers three sorts', () => {
    expect(getRosterSort()).toBe('last');
    expect(ROSTER_SORTS.map((x) => x.id)).toEqual(['first', 'last', 'gender']);
  });

  it('is kept on this device, one key for every course', () => {
    setRosterSort('first');
    expect(localStorage.getItem('prism:roster:sort')).toBe('first');
    expect(getRosterSort()).toBe('first');
  });

  it('an unknown stored value means last name', () => {
    localStorage.setItem('prism:roster:sort', 'banana');
    expect(getRosterSort()).toBe('last');
  });

  it('storage that throws: reads mean last name, a write is held in memory', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(getRosterSort()).toBe('last');
    setRosterSort('gender');
    expect(getRosterSort()).toBe('gender');
  });

  it('Gender without Private details sorts by last name and leaves the stored value alone', () => {
    setRosterSort('gender');
    expect(effectiveSort('gender', false)).toBe('last');
    expect(effectiveSort('gender', true)).toBe('gender');
    expect(effectiveSort('first', false)).toBe('first');
    expect(localStorage.getItem('prism:roster:sort')).toBe('gender');
  });
});
