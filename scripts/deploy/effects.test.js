import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { parseCiRuns, healthCheck, serverAnswers } from './effects.js';

const SHA = 'c'.repeat(40);

// Field names as observed from GET /repos/ganolan/prism/actions/workflows/<file>/runs, 2026-09-23.
const runFor = (overrides) => ({
  id: 1, name: 'CI', event: 'push', status: 'completed', conclusion: 'success',
  head_sha: SHA, head_branch: 'main', created_at: '2026-09-23T06:00:00Z', run_number: 1,
  ...overrides,
});

describe('parseCiRuns', () => {
  it('is missing when CI has not started', () => {
    expect(parseCiRuns({ total_count: 0, workflow_runs: [] }, SHA)).toBe('missing');
  });

  it('is pending while a run is queued or in progress', () => {
    for (const status of ['queued', 'in_progress', 'waiting', 'requested']) {
      expect(parseCiRuns({ workflow_runs: [runFor({ status, conclusion: null })] }, SHA)).toBe('pending');
    }
  });

  it("reports a finished run's conclusion", () => {
    expect(parseCiRuns({ workflow_runs: [runFor({})] }, SHA)).toBe('success');
    expect(parseCiRuns({ workflow_runs: [runFor({ conclusion: 'failure' })] }, SHA)).toBe('failure');
  });

  it('believes the newest run when there are several', () => {
    const runs = [runFor({ run_number: 1, conclusion: 'failure' }), runFor({ run_number: 2, conclusion: 'success' })];
    expect(parseCiRuns({ workflow_runs: runs }, SHA)).toBe('success');
  });

  it('ignores pull-request runs and runs for other commits', () => {
    const runs = [runFor({ event: 'pull_request' }), runFor({ head_sha: 'd'.repeat(40) })];
    expect(parseCiRuns({ workflow_runs: runs }, SHA)).toBe('missing');
  });
});

describe('healthCheck', () => {
  let server, url, served;
  beforeEach(async () => {
    served = 'old';
    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ sha: served, builtAt: null, mode: 'release' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}/api/version`;
  });
  afterEach(() => new Promise((resolve) => server.close(resolve)));

  it('passes once the expected commit is the one answering', async () => {
    served = SHA;
    expect(await healthCheck(SHA, { url, timeoutMs: 1000, intervalMs: 50 })).toBe(true);
  });

  it('fails while a different commit is still answering', async () => {
    expect(await healthCheck(SHA, { url, timeoutMs: 300, intervalMs: 50 })).toBe(false);
  });

  it('serverAnswers is true for any answer and false for none', async () => {
    expect(await serverAnswers({ url, timeoutMs: 500 })).toBe(true);
    const closed = url;
    await new Promise((resolve) => server.close(resolve));
    server = http.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    expect(await serverAnswers({ url: closed, timeoutMs: 500 })).toBe(false);
  });

  // A server that accepts the connection and never answers must not hang the check.
  it('gives up on a server that never replies', async () => {
    const silent = http.createServer(() => {});
    await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const started = Date.now();
    const ok = await healthCheck(SHA, {
      url: `http://127.0.0.1:${silent.address().port}/api/version`, timeoutMs: 300, intervalMs: 50,
    });
    silent.closeAllConnections();
    await new Promise((resolve) => silent.close(resolve));
    expect(ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('fails when nothing is listening', async () => {
    const closed = url;
    await new Promise((resolve) => server.close(resolve));
    server = http.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    expect(await healthCheck(SHA, { url: closed, timeoutMs: 300, intervalMs: 50 })).toBe(false);
  });
});
