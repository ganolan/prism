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

  // A relative path means "whichever directory the client launched me from",
  // and a committed project-scope entry outranks the user's own route to the
  // server's database. Both make the target database an accident of context.
  it('refuses a relative path', () => {
    expect(() => assertExplicitDbPath({ DB_PATH: 'server/db/students.db' })).toThrow(/ABSOLUTE DB_PATH/);
    expect(() => assertExplicitDbPath({ DB_PATH: './students.db' })).toThrow(/ABSOLUTE DB_PATH/);
  });

  it('accepts a SQLite file: URI', () => {
    expect(assertExplicitDbPath({ DB_PATH: 'file:/tmp/x.db?mode=ro' })).toBe('file:/tmp/x.db?mode=ro');
  });

  it('leaves an absolute path alone', () => {
    expect(assertExplicitDbPath({ DB_PATH: '/Users/gnolan/prism/data/students.db' }))
      .toBe('/Users/gnolan/prism/data/students.db');
  });
});
