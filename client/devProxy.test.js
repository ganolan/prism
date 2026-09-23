import { describe, it, expect } from 'vitest';
import { devApiTarget } from './devProxy.js';

// On the mini, prod owns :3001. A dev clone there runs `PORT=3002 npm run dev`;
// if Vite still proxied /api to :3001, the "dev" UI would write to prod.
describe('devApiTarget', () => {
  it('follows PORT, so a dev clone beside prod talks to its own API', () => {
    expect(devApiTarget({ PORT: '3002' })).toBe('http://localhost:3002');
  });

  it('defaults to 3001', () => {
    expect(devApiTarget({})).toBe('http://localhost:3001');
    expect(devApiTarget({ PORT: '  ' })).toBe('http://localhost:3001');
  });
});
