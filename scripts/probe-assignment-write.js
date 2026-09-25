// Probe: can the public Schoology API create and update assignments, and does a written
// description keep its HTML and inline styles?
//
//   node --env-file=.env scripts/probe-assignment-write.js read  <sectionId> <assignmentId>
//   node --env-file=.env scripts/probe-assignment-write.js write <sectionId>
//
// "read" is harmless: it GETs one assignment and reports what the description looks like.
// "write" creates ONE unpublished assignment titled "ZZ API probe - safe to delete", updates it,
// reads it back, reports whether HTML survived, then deletes it. Run "write" only with Graham's
// go-ahead, in a section he names.
import { apiGet, apiPut, apiPost } from '../server/services/schoology.js';

const [mode, sectionId, assignmentId] = process.argv.slice(2);
const API = `${process.env.SCHOOLOGY_BASE_URL}/v1`;

function describe(label, a) {
  const d = a.description || '';
  console.log(`${label}: id=${a.id} published=${a.published} folder_id=${a.folder_id} type=${a.type}`);
  console.log(`  description length ${d.length}, has "<" ${d.includes('<')}, has style= ${d.includes('style=')}`);
  console.log(`  first 200 chars: ${JSON.stringify(d.slice(0, 200))}`);
}

if (mode === 'read') {
  const a = await apiGet(`/sections/${sectionId}/assignments/${assignmentId}`);
  describe('existing', a);
  const b = await apiGet(`/sections/${sectionId}/assignments/${assignmentId}?with_attachments=1&richtext=1`);
  describe('with richtext=1', b);
} else if (mode === 'write') {
  const html = '<h2 style="color: #1E3A8A;">Probe heading</h2><p>Plain <strong>bold</strong> and <span style="color:#B45309;">styled</span> text.</p><table style="border-collapse: collapse;"><tr><td style="background-color:#FCE5CD;padding:6px;">cell</td></tr></table>';
  const created = await apiPost(`/sections/${sectionId}/assignments`, {
    title: 'ZZ API probe - safe to delete', description: html, published: 0, type: 'assignment',
  });
  console.log('create status', created.status, JSON.stringify(created.data).slice(0, 300));
  const id = created.data && created.data.id;
  if (!id) process.exit(1);
  const upd = await apiPut(`/sections/${sectionId}/assignments/${id}`, { description: html + '<p>updated</p>' });
  console.log('update status', upd.status);
  const back = await apiGet(`/sections/${sectionId}/assignments/${id}?richtext=1`);
  describe('read back', back);
  const { default: OAuth } = await import('oauth-1.0a');
  const oauth = OAuth({ consumer: { key: process.env.SCHOOLOGY_CONSUMER_KEY, secret: process.env.SCHOOLOGY_CONSUMER_SECRET }, signature_method: 'PLAINTEXT' });
  const url = `${API}/sections/${sectionId}/assignments/${id}`;
  const del = await fetch(url, { method: 'DELETE', headers: oauth.toHeader(oauth.authorize({ url, method: 'DELETE' }, { key: '', secret: '' })) });
  console.log('delete status', del.status, '(check Schoology: if not 204, delete "ZZ API probe" by hand)');
} else {
  console.log('usage: read <sectionId> <assignmentId> | write <sectionId>');
}
