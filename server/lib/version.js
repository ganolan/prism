/**
 * What is actually running.
 *
 * A deploy stamps the process (PRISM_GIT_SHA / PRISM_BUILT_AT) and writes
 * release.json at the release root; nothing else creates either. A checkout
 * with neither is a dev clone and says so — which is the useful answer when a
 * local client is proxying /api at the server, because the badge then names
 * the backend rather than the page.
 *
 * Never throws: release.json is written during a deploy swap, and a
 * half-written file must not take the endpoint down.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const RELEASE_FILE = join(__dirname, '..', '..', 'release.json');
export const DEV_VERSION = Object.freeze({ sha: null, builtAt: null, mode: 'dev' });

const str = (value) => (typeof value === 'string' ? value.trim() : '');

export function resolveVersion({ env = process.env, releaseFile = RELEASE_FILE, read = readFileSync } = {}) {
  const envSha = str(env.PRISM_GIT_SHA);
  if (envSha) {
    return { sha: envSha, builtAt: str(env.PRISM_BUILT_AT) || null, mode: 'release' };
  }

  try {
    const parsed = JSON.parse(read(releaseFile, 'utf8'));
    const sha = str(parsed?.sha);
    if (!sha) return { ...DEV_VERSION };
    return { sha, builtAt: str(parsed?.builtAt) || null, mode: 'release' };
  } catch {
    return { ...DEV_VERSION };
  }
}
