import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// A test that calls getDb() without an in-memory DB_PATH (or a mocked getDb) opens the clone's real
// database at server/db/students.db, and its DELETE statements run there. Found 23 October 2026
// (#174): savedGrades.test.js tried to empty a dev copy's grades, students and courses, and failed
// only because a foreign key stopped it. Every test file that calls getDb() must isolate it
// (DB_PATH ':memory:' set in vi.hoisted, a vi.mock of db/index.js, or __setTestDb).
const ROOT = join(import.meta.dirname, '..', '..');
const DIRS = ['server', 'mcp', 'scripts'];

function testFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules') return [];
    if (statSync(path).isDirectory()) return testFiles(path);
    return name.endsWith('.test.js') ? [path] : [];
  });
}

describe('test database isolation', () => {
  // The backstop (23 Oct 2026): schoologyLogin.test.js reached getDb() through the route it tests,
  // which no file scan can see, and created server/db/students.db. vitest.config.js sets DB_PATH for
  // every test file; this file sets nothing, so it reads the config's value.
  test('every test file starts with an in-memory DB_PATH (vitest.config.js test.env)', () => {
    expect(process.env.DB_PATH).toBe(':memory:');
  });

  test('every test file that calls getDb() uses an in-memory database, a mocked getDb or an injected one', () => {
    const open = DIRS.flatMap((d) => testFiles(join(ROOT, d)))
      .filter((f) => /\bgetDb\(\)/.test(readFileSync(f, 'utf8')))
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        return !src.includes("DB_PATH = ':memory:'") && !/vi\.mock\([^)]*db\/index\.js/.test(src) && !src.includes('__setTestDb');
      })
      .map((f) => relative(ROOT, f));
    expect(open).toEqual([]);
  });
});
