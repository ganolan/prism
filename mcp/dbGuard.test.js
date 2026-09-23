import { describe, it, expect } from 'vitest';
import { assertExplicitDbPath } from './dbGuard.js';

describe('assertExplicitDbPath', () => {
  it('returns the path when one was declared', () => {
    expect(assertExplicitDbPath({ DB_PATH: '/Users/gnolan/prism/data/students.db' }))
      .toBe('/Users/gnolan/prism/data/students.db');
  });

  // Review Focus 5: every MCP test seeds an in-memory database.
  it('accepts :memory:', () => {
    expect(assertExplicitDbPath({ DB_PATH: ':memory:' })).toBe(':memory:');
  });

  it('refuses an unset, empty or whitespace DB_PATH', () => {
    expect(() => assertExplicitDbPath({})).toThrow(/explicit DB_PATH/);
    expect(() => assertExplicitDbPath({ DB_PATH: '' })).toThrow(/explicit DB_PATH/);
    expect(() => assertExplicitDbPath({ DB_PATH: '   ' })).toThrow(/explicit DB_PATH/);
  });

  it('tells the reader how to fix it', () => {
    expect(() => assertExplicitDbPath({})).toThrow(/DB_PATH=/);
  });
});
