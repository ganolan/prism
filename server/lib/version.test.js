import { describe, it, expect } from 'vitest';
import { resolveVersion, DEV_VERSION } from './version.js';

const reads = (contents) => () => {
  if (contents === null) throw new Error('ENOENT');
  return contents;
};

describe('resolveVersion', () => {
  it('reports a dev clone when there is no release marker and no env', () => {
    expect(resolveVersion({ env: {}, read: reads(null) })).toEqual({
      sha: null,
      builtAt: null,
      mode: 'dev',
    });
    expect(DEV_VERSION.mode).toBe('dev');
  });

  it('prefers the environment, which is how the deploy stamps a running process', () => {
    expect(
      resolveVersion({
        env: { PRISM_GIT_SHA: '1e96c01', PRISM_BUILT_AT: '2026-09-23T01:06:43Z' },
        read: reads('{"sha":"deadbee","builtAt":"2020-01-01T00:00:00Z"}'),
      }),
    ).toEqual({ sha: '1e96c01', builtAt: '2026-09-23T01:06:43Z', mode: 'release' });
  });

  it('falls back to release.json', () => {
    expect(
      resolveVersion({
        env: {},
        read: reads('{"sha":"1e96c01","builtAt":"2026-09-23T01:06:43Z"}'),
      }),
    ).toEqual({ sha: '1e96c01', builtAt: '2026-09-23T01:06:43Z', mode: 'release' });
  });

  it('treats a release with no builtAt as a release with no build time', () => {
    expect(resolveVersion({ env: {}, read: reads('{"sha":"1e96c01"}') })).toEqual({
      sha: '1e96c01',
      builtAt: null,
      mode: 'release',
    });
  });

  // Review Focus 2: release.json is written during a deploy swap, which is
  // exactly when someone is refreshing to see whether the deploy landed.
  it('reports dev rather than throwing on a half-written or junk release.json', () => {
    expect(resolveVersion({ env: {}, read: reads('{"sha":"1e9') })).toEqual(DEV_VERSION);
    expect(resolveVersion({ env: {}, read: reads('') })).toEqual(DEV_VERSION);
    expect(resolveVersion({ env: {}, read: reads('{}') })).toEqual(DEV_VERSION);
    expect(resolveVersion({ env: {}, read: reads('{"sha":123}') })).toEqual(DEV_VERSION);
    expect(resolveVersion({ env: {}, read: reads('null') })).toEqual(DEV_VERSION);
  });
});
