import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
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

  // A *relative* DB_PATH still means "whichever directory I was launched from"
  // — the implicitness this guard exists to remove. It stays allowed, because
  // the committed .mcp.json uses one and a clone beside its own database is the
  // correct default today, but the process resolves and reports the absolute
  // path so which database it opened is never left to inference.
  it('resolves a relative path against the working directory', () => {
    expect(assertExplicitDbPath({ DB_PATH: 'server/db/students.db' }))
      .toBe(resolve(process.cwd(), 'server/db/students.db'));
  });

  it('leaves an absolute path alone', () => {
    expect(assertExplicitDbPath({ DB_PATH: '/Users/gnolan/prism/data/students.db' }))
      .toBe('/Users/gnolan/prism/data/students.db');
  });
});
