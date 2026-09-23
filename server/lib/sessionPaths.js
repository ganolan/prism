/**
 * Where the saved Schoology / PowerSchool browser session lives.
 *
 * Resolved per call rather than at module load, and overridable by
 * PRISM_SESSION_DIR. On the server the session must sit in ~/prism/data/,
 * outside the deployed release — a session inside a release is swapped away by
 * the next deploy, and mastery sync then fails until someone re-logs in
 * (docs/adr/0003, and the hosting design's release layout).
 */
import { mkdirSync } from 'fs';
import { join } from 'path';

export const SESSION_DIR_NAME = '.playwright-session';
export const STATE_FILE_NAME = 'storage-state.json';

export function sessionDir(env = process.env) {
  const dir = String(env.PRISM_SESSION_DIR ?? '').trim();
  return dir || join(process.cwd(), SESSION_DIR_NAME);
}

export function sessionStateFile(env = process.env) {
  return join(sessionDir(env), STATE_FILE_NAME);
}

/** Session directory, created if absent (parents included). Returns the path. */
export function ensureSessionDir(env = process.env) {
  const dir = sessionDir(env);
  mkdirSync(dir, { recursive: true });
  return dir;
}
