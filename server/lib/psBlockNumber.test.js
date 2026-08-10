import { describe, test, expect } from 'vitest';
import {
  blockNumberFromName,
  resolveSectionBlock,
  pickBlockNumber,
  sectionDcidFromLaunchForm,
  loopTimeBudgetExceeded,
} from './psBlockNumber.js';

// Minimal section_info[0] fixtures built from the real shapes observed on
// 2026-06-08 (scripts/probe-ps-block-number.js). The displayed "Block N" is
// bellScheduleItems[].period.name for the periodId in periodIdToPsmPeriodIdMap.

// ACSS — periodId 4202, name "Block 3"; many bell-schedule variants, same period.
const ACSS = {
  courseName: 'ADVANCED COMPUTER SCIENCE STUDIO',
  expression: '2(A-B)',
  periodIdToPsmPeriodIdMap: { '4202': '18149253' },
  bellScheduleItems: [
    { periodId: 4202, period: { id: 4202, periodNumber: 2, name: 'Block 3', abbreviation: 'BK3', sortOrder: 2 } },
    { periodId: 4202, period: { id: 4202, periodNumber: 2, name: 'Block 3', abbreviation: 'BK3', sortOrder: 2 } },
  ],
  sectionMeetings: [
    { periodNumber: 2, cycleDayLetter: 'A', meeting: '2(A)' },
    { periodNumber: 2, cycleDayLetter: 'B', meeting: '2(B)' },
  ],
};

// APCSP — the proof that period.name ≠ periodNumber ≠ expression number.
// expression "7(A-B)", periodNumber 7, but the displayed block is "Block 6".
const APCSP = {
  courseName: 'AP COMPUTER SCIENCE PRINCIPLES',
  expression: '7(A-B)',
  periodIdToPsmPeriodIdMap: { '4207': '18100000' },
  bellScheduleItems: [
    { periodId: 4207, period: { id: 4207, periodNumber: 7, name: 'Block 6', abbreviation: 'BK6' } },
  ],
};

// PCG — not a numbered block.
const PCG = {
  courseName: 'PCG',
  periodIdToPsmPeriodIdMap: { '4211': '18111111' },
  bellScheduleItems: [
    { periodId: 4211, period: { id: 4211, periodNumber: 11, name: 'Pastoral Care', abbreviation: 'PCG' } },
  ],
};

describe('blockNumberFromName', () => {
  test('parses the digit from "Block N"', () => {
    expect(blockNumberFromName('Block 3')).toBe('3');
    expect(blockNumberFromName('Block 8')).toBe('8');
  });

  test('parses a two-digit block', () => {
    expect(blockNumberFromName('Block 12')).toBe('12');
  });

  test('trims surrounding whitespace', () => {
    expect(blockNumberFromName('  Block 3 ')).toBe('3');
  });

  test('returns null for non-numbered period names', () => {
    expect(blockNumberFromName('Pastoral Care')).toBe(null);
    expect(blockNumberFromName('Interim')).toBe(null);
  });

  test('returns null for empty / nullish input', () => {
    expect(blockNumberFromName('')).toBe(null);
    expect(blockNumberFromName(null)).toBe(null);
    expect(blockNumberFromName(undefined)).toBe(null);
  });
});

describe('resolveSectionBlock', () => {
  test('resolves ACSS to a single block "Block 3"', () => {
    const r = resolveSectionBlock(ACSS);
    expect(r.periodIds).toEqual([4202]);
    expect(r.blocks).toEqual([
      { name: 'Block 3', abbreviation: 'BK3', periodNumber: 2, periodId: 4202 },
    ]);
  });

  test('uses period.name, not periodNumber (APCSP: periodNumber 7 → "Block 6")', () => {
    const r = resolveSectionBlock(APCSP);
    expect(r.blocks.map((b) => b.name)).toEqual(['Block 6']);
    expect(r.blocks[0].periodNumber).toBe(7);
  });

  test('excludes bellScheduleItems whose periodId is not the section\'s period', () => {
    const withForeign = {
      ...ACSS,
      bellScheduleItems: [
        ...ACSS.bellScheduleItems,
        { periodId: 9999, period: { id: 9999, periodNumber: 9, name: 'Block 9', abbreviation: 'BK9' } },
      ],
    };
    expect(resolveSectionBlock(withForeign).blocks.map((b) => b.name)).toEqual(['Block 3']);
  });

  test('handles bellScheduleItems delivered as an object map', () => {
    const objMap = {
      ...ACSS,
      bellScheduleItems: { 0: ACSS.bellScheduleItems[0], 1: ACSS.bellScheduleItems[1] },
    };
    expect(resolveSectionBlock(objMap).blocks.map((b) => b.name)).toEqual(['Block 3']);
  });

  test('returns empty blocks for missing / null input', () => {
    expect(resolveSectionBlock(null)).toEqual({ periodIds: [], blocks: [] });
    expect(resolveSectionBlock({})).toEqual({ periodIds: [], blocks: [] });
  });
});

describe('pickBlockNumber', () => {
  test('ACSS → blockNumber "3"', () => {
    expect(pickBlockNumber(ACSS)).toEqual({ blockNumber: '3', blockName: 'Block 3', reason: 'ok' });
  });

  test('APCSP → blockNumber "6" (from name, not periodNumber 7)', () => {
    expect(pickBlockNumber(APCSP)).toEqual({ blockNumber: '6', blockName: 'Block 6', reason: 'ok' });
  });

  test('PCG → null with reason "not-numbered", name preserved', () => {
    expect(pickBlockNumber(PCG)).toEqual({ blockNumber: null, blockName: 'Pastoral Care', reason: 'not-numbered' });
  });

  test('no resolvable block → reason "no-block"', () => {
    expect(pickBlockNumber({})).toEqual({ blockNumber: null, blockName: null, reason: 'no-block' });
  });

  test('two distinct blocks → reason "ambiguous"', () => {
    const ambiguous = {
      periodIdToPsmPeriodIdMap: { '1': 'a', '2': 'b' },
      bellScheduleItems: [
        { periodId: 1, period: { id: 1, periodNumber: 1, name: 'Block 1', abbreviation: 'BK1' } },
        { periodId: 2, period: { id: 2, periodNumber: 2, name: 'Block 2', abbreviation: 'BK2' } },
      ],
    };
    expect(pickBlockNumber(ambiguous)).toEqual({ blockNumber: null, blockName: null, reason: 'ambiguous' });
  });
});

describe('sectionDcidFromLaunchForm', () => {
  test('extracts custom_sectiondcid from the LTI launch form HTML', () => {
    const html = '<form><input type="hidden" name="custom_sectiondcid" value="49355"/></form>';
    expect(sectionDcidFromLaunchForm(html)).toBe('49355');
  });

  test('returns null when the value is empty (template/master course)', () => {
    const html = '<input name="custom_sectiondcid" value=""/>';
    expect(sectionDcidFromLaunchForm(html)).toBe(null);
  });

  test('returns null when the field is absent (e.g. an SSO login page)', () => {
    expect(sectionDcidFromLaunchForm('<html><body>Sign in</body></html>')).toBe(null);
    expect(sectionDcidFromLaunchForm('')).toBe(null);
    expect(sectionDcidFromLaunchForm(null)).toBe(null);
  });
});

describe('loopTimeBudgetExceeded', () => {
  test('false while under budget', () => {
    expect(loopTimeBudgetExceeded(1000, 5000, 1000)).toBe(false);
    expect(loopTimeBudgetExceeded(1000, 5000, 5999)).toBe(false);
  });

  test('true once elapsed reaches or exceeds the budget', () => {
    expect(loopTimeBudgetExceeded(1000, 5000, 6000)).toBe(true);
    expect(loopTimeBudgetExceeded(1000, 5000, 9000)).toBe(true);
  });

  test('defaults `now` to Date.now() when omitted', () => {
    const startedAt = Date.now() - 10;
    expect(loopTimeBudgetExceeded(startedAt, 100_000)).toBe(false);
  });
});
