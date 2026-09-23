import { describe, it, expect } from 'vitest';

// Review Focus 5: the guard belongs to the CLI entry, not module scope. If it
// ran at import, every MCP test file would fail before its first assertion.
describe('importing the MCP server', () => {
  it('does not run the DB_PATH guard', async () => {
    delete process.env.DB_PATH;
    const mod = await import('./server.js');
    expect(typeof mod.createServer).toBe('function');
  });
});
