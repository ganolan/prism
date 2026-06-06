import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getDb } from '../server/db/index.js';
import { createServer, connectDb, INSTRUCTIONS } from './server.js';

// Spin up the PrisMCP server and a client linked by an in-memory transport
// pair, so tests exercise the real MCP request/response path (registration,
// dispatch, serialization) without stdio.
async function connect() {
  const server = createServer();
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

beforeEach(() => {
  getDb().exec(
    'DELETE FROM mastery_alignments; DELETE FROM grades; DELETE FROM assignments; ' +
    'DELETE FROM students; DELETE FROM courses;'
  );
});

describe('PrisMCP server', () => {
  test('exposes list_courses returning active courses to a connected client', async () => {
    getDb().prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1', 'Robotics')`
    ).run();
    const client = await connect();
    const res = await client.callTool({ name: 'list_courses', arguments: {} });
    const data = JSON.parse(res.content[0].text);
    expect(data.map((c) => c.course_name)).toEqual(['Robotics']);
  });

  test('exposes list_assignments scoped to the requested course', async () => {
    const db = getDb();
    const c1 = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1', 'MAD')`).run().lastInsertRowid;
    const c2 = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s2', 'ROB')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'a1', 'App Project')`).run(c1);
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'a2', 'Other Course Task')`).run(c2);
    const client = await connect();
    const res = await client.callTool({ name: 'list_assignments', arguments: { course_id: c1 } });
    const data = JSON.parse(res.content[0].text);
    expect(data.map((a) => a.title)).toEqual(['App Project']);
  });

  test('advertises the tool-search instructions to the client', async () => {
    const client = await connect();
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    expect(INSTRUCTIONS.length).toBeLessThan(2048);
  });

  test('connectDb sets busy_timeout so MCP writes coexist with the Express server', () => {
    const db = connectDb();
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });
});
