import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'http';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getDb } from '../db/index.js';
import { createServer } from '../../mcp/server.js';
import { mountMcp } from './mcp.js';

const ALLOWED_ORIGINS = ['https://prism.swordtail-everest.ts.net'];
const open = []; // every server, client and transport a test started, closed after it

function listen(app, port = 0) {
  return new Promise((resolve) => {
    const server = app.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function startApp({ devCopy = false, port = 0 } = {}) {
  const app = express();
  mountMcp(app, { allowedOrigins: ALLOWED_ORIGINS, devCopy });
  const server = await listen(app, port);
  open.push(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { server, port: server.address().port };
}

async function connectClient(port) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(transport);
  open.push(() => client.close());
  return client;
}

// A raw request, for the headers (Host, Origin) a client library will not set.
function rawPost(port, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const req = http.request({
      host: '127.0.0.1', port, path: '/mcp', method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(body);
  });
}

beforeEach(() => {
  getDb().exec(
    'DELETE FROM resubmissions; DELETE FROM status_lines; DELETE FROM enrolments; DELETE FROM assignments; ' +
    'DELETE FROM students; DELETE FROM courses;'
  );
});

afterEach(async () => {
  while (open.length) await open.pop()();
});

function seedPair() {
  const db = getDb();
  const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1', 'Robotics')`).run().lastInsertRowid;
  const assignmentId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'a1', 'Project')`).run(courseId).lastInsertRowid;
  const studentId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-1', 'Ada', 'Lovelace')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'enr-1')`).run(studentId, courseId);
  return { courseId, assignmentId, studentId };
}

describe('/mcp over HTTP', () => {
  test('lists the same tools as createServer() over HTTP', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const direct = new Client({ name: 'direct', version: '1.0.0' });
    await Promise.all([createServer().connect(serverTransport), direct.connect(clientTransport)]);
    open.push(() => direct.close());

    const { port } = await startApp();
    const client = await connectClient(port);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual((await direct.listTools()).tools.map((t) => t.name).sort());
    expect(names).toContain('get_assignment_context');
  });

  test('calls list_courses over HTTP and gets the seeded course', async () => {
    seedPair();
    const { port } = await startApp();
    const client = await connectClient(port);
    const res = await client.callTool({ name: 'list_courses', arguments: {} });
    expect(JSON.parse(res.content[0].text).map((c) => c.course_name)).toEqual(['Robotics']);
  });

  test('GET and DELETE answer 405 (stateless: no stream to resume, no session to end)', async () => {
    const { port } = await startApp();
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method, headers: { Accept: 'text/event-stream' } });
      expect(res.status).toBe(405);
    }
  });

  test("refuses a Host that is not Prism's (DNS rebinding) with 403", async () => {
    const { port } = await startApp();
    expect(await rawPost(port, { Host: 'evil.example.com' })).toBe(403);
    expect(await rawPost(port, { Host: `evil.example.com:${port}` })).toBe(403);
  });

  test("answers the tailnet name on any port, and the loopback names (Host is checked without its port)", async () => {
    const { port } = await startApp();
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, 'prism.swordtail-everest.ts.net']) {
      expect(await rawPost(port, { Host: host })).toBe(200);
    }
  });

  test('refuses a POST whose Origin is another site with 403', async () => {
    const { port } = await startApp();
    expect(await rawPost(port, { Origin: 'https://evil.example.com' })).toBe(403);
    expect(await rawPost(port, { Origin: 'null' })).toBe(403);
  });

  test('a request survives a server restart: a new app on the same port answers the next call', async () => {
    seedPair();
    const first = await startApp();
    const client = await connectClient(first.port);
    expect((await client.callTool({ name: 'list_courses', arguments: {} })).isError).toBeFalsy();

    await new Promise((resolve) => { first.server.close(resolve); first.server.closeAllConnections(); });
    await startApp({ port: first.port });
    await new Promise((resolve) => setTimeout(resolve, 50)); // the client's pooled socket notices the close
    const res = await client.callTool({ name: 'list_courses', arguments: {} });
    expect(JSON.parse(res.content[0].text).map((c) => c.course_name)).toEqual(['Robotics']);
  });

  describe('a dev copy', () => {
    test('every tool result starts with the dev-copy warning, errors too', async () => {
      seedPair();
      const { port } = await startApp({ devCopy: true });
      const client = await connectClient(port);

      const ok = await client.callTool({ name: 'list_courses', arguments: {} });
      expect(ok.content[0].text).toMatch(/dev copy of Prism/i);
      expect(JSON.parse(ok.content[1].text).map((c) => c.course_name)).toEqual(['Robotics']);

      const bad = await client.callTool({ name: 'list_assignments', arguments: { course_id: 999999 } });
      const err = await client.callTool({ name: 'get_assignment_context', arguments: { course_id: 999999, assignment_id: 'nope', use_stored_data: true } });
      for (const r of [bad, err]) expect(r.content[0].text).toMatch(/dev copy of Prism/i);
      expect(err.isError).toBe(true);
    });

    test('a production server adds no warning', async () => {
      seedPair();
      const { port } = await startApp({ devCopy: false });
      const client = await connectClient(port);
      const res = await client.callTool({ name: 'list_courses', arguments: {} });
      expect(res.content).toHaveLength(1);
    });

    test('refuses request_resubmission with comment_line (DEV_COPY), and records nothing', async () => {
      const { studentId, assignmentId } = seedPair();
      const { port } = await startApp({ devCopy: true });
      const client = await connectClient(port);
      const res = await client.callTool({
        name: 'request_resubmission',
        arguments: { student_id: studentId, assignment_id: assignmentId, lessons: 3, comment_line: 'Resubmission requested - due Thu 24/10.', unsubmit: false },
      });
      expect(res.isError).toBe(true);
      expect(res.content[1].text).toMatch(/^DEV_COPY:/);
      expect(res.content[1].text).toMatch(/without comment_line/);
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM resubmissions').get().n).toBe(0);
    });

    test('refuses request_resubmission with unsubmit: true (DEV_COPY)', async () => {
      const { studentId, assignmentId } = seedPair();
      const { port } = await startApp({ devCopy: true });
      const client = await connectClient(port);
      const res = await client.callTool({
        name: 'request_resubmission', arguments: { student_id: studentId, assignment_id: assignmentId, unsubmit: true },
      });
      expect(res.isError).toBe(true);
      expect(res.content[1].text).toMatch(/^DEV_COPY:/);
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM resubmissions').get().n).toBe(0);
    });

    test('a Prism-only request_resubmission (unsubmit: false, no comment_line) still works', async () => {
      const { studentId, assignmentId } = seedPair();
      const { port } = await startApp({ devCopy: true });
      const client = await connectClient(port);
      const res = await client.callTool({
        name: 'request_resubmission', arguments: { student_id: studentId, assignment_id: assignmentId, unsubmit: false },
      });
      expect(res.isError).toBeFalsy();
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM resubmissions').get().n).toBe(1);
    });
  });
});
