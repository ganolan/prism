import { describe, it, expect } from 'vitest';
import { resolveHost, resolvePort, DEFAULT_HOST, DEFAULT_PORT } from './listenConfig.js';

describe('resolveHost', () => {
  it('defaults to loopback so the tailnet is the only route in', () => {
    expect(resolveHost({})).toBe('127.0.0.1');
    expect(DEFAULT_HOST).toBe('127.0.0.1');
  });

  it('treats an empty or whitespace HOST as unset', () => {
    expect(resolveHost({ HOST: '' })).toBe('127.0.0.1');
    expect(resolveHost({ HOST: '   ' })).toBe('127.0.0.1');
  });

  // Review Focus 1: loopback is a default, not a hardcode.
  it('honours an explicit override', () => {
    expect(resolveHost({ HOST: '0.0.0.0' })).toBe('0.0.0.0');
    expect(resolveHost({ HOST: '::1' })).toBe('::1');
  });
});

describe('resolvePort', () => {
  it('defaults to 3001', () => {
    expect(resolvePort({})).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(3001);
  });

  it('parses a numeric PORT, including 0 for an ephemeral port', () => {
    expect(resolvePort({ PORT: '3002' })).toBe(3002);
    expect(resolvePort({ PORT: '0' })).toBe(0);
  });

  it('falls back to the default rather than binding a nonsense port', () => {
    expect(resolvePort({ PORT: 'not-a-port' })).toBe(3001);
    expect(resolvePort({ PORT: '99999' })).toBe(3001);
    expect(resolvePort({ PORT: '-1' })).toBe(3001);
  });
});
