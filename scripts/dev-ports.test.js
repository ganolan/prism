import { describe, it, expect } from 'vitest';
import { classifyListeners, preflightMessage } from './dev-ports.js';

const REPO = '/Users/t/repos/prism';
const PROD = { pid: 15851, port: 3001, cwd: '/Users/t/prism/releases/20260927T144339Z-4cdf4e5', command: 'node' };

describe('classifyListeners', () => {
  it('owns listeners running from this clone, including client/ (Vite)', () => {
    const api = { pid: 1, port: 3001, cwd: REPO, command: 'node' };
    const vite = { pid: 2, port: 5173, cwd: `${REPO}/client`, command: 'node' };
    expect(classifyListeners([api, vite], REPO)).toEqual({ owned: [api, vite], foreign: [] });
  });

  it('treats prod (a release dir outside the clone) as foreign — never ours to kill', () => {
    expect(classifyListeners([PROD], REPO)).toEqual({ owned: [], foreign: [PROD] });
  });

  it('a sibling path that merely starts with the repo path is foreign', () => {
    const sibling = { pid: 3, port: 3001, cwd: `${REPO}-old`, command: 'node' };
    expect(classifyListeners([sibling], REPO).foreign).toEqual([sibling]);
  });

  it('an unknown cwd is foreign (fail safe)', () => {
    const unknown = { pid: 4, port: 3001, cwd: null, command: 'node' };
    expect(classifyListeners([unknown], REPO).foreign).toEqual([unknown]);
  });
});

describe('preflightMessage', () => {
  it('null when the API port is free', () => {
    expect(preflightMessage({ port: 3001, owned: [], foreign: [], portFromEnv: false })).toBeNull();
  });

  it('refuses when another install (prod) holds the port, pointing at PORT=3002', () => {
    const msg = preflightMessage({ port: 3001, owned: [], foreign: [PROD], portFromEnv: false });
    expect(msg).toMatch(/NOT this clone/);
    expect(msg).toMatch(/PORT=3002 npm run dev/);
    expect(msg).toMatch(/do not kill/i);
  });

  it('points at dev:stop when this clone\'s own stale server holds the port', () => {
    const msg = preflightMessage({ port: 3001, owned: [{ ...PROD, cwd: REPO }], foreign: [], portFromEnv: false });
    expect(msg).toMatch(/npm run dev:stop/);
  });
});
