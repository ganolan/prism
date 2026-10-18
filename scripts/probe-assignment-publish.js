// Probe (#138): does PUT /v1/sections/{id}/assignments/{aid} with `published`
// change an EXISTING assignment and an existing test, in each direction?
// The 25/09/2026 probe only set `published` on create.
//
// Every command but `get` is ONE write; run each only with Graham's go-ahead,
// on a temporary item in a section he names.
//
//   node --env-file=.env scripts/probe-assignment-publish.js get       <section> <id>
//   node --env-file=.env scripts/probe-assignment-publish.js create    <section>        (unpublished assignment)
//   node --env-file=.env scripts/probe-assignment-publish.js publish   <section> <id> 0|1
//   node --env-file=.env scripts/probe-assignment-publish.js rename    <section> <id>   (title only)
//   node --env-file=.env scripts/probe-assignment-publish.js delete    <section> <id>   (API DELETE, an assignment)
//
// Run 18/10/2026: an assignment (create, 1, 0, delete) and an existing
// unpublished test (1, 0) in archived section 7899896088; results in
// schoology-api-reference.md, "Writing assignments".
import { apiGet, apiPut, apiPost, apiDelete } from '../server/services/schoology.js';

const PROBE_TITLE = 'Prism probe - ignore (F)';
const [cmd, a1, a2, a3] = process.argv.slice(2);

async function show(label, section, id) {
  const a = await apiGet(`/sections/${section}/assignments/${id}`);
  const pick = ({ id, title, type, published, available, last_updated, num_assignees, folder_id }) =>
    ({ id, title, type, published, available, last_updated, num_assignees, folder_id });
  console.log(label, JSON.stringify(pick(a)));
  return a;
}

if (cmd === 'get') {
  await show('read:', a1, a2);
} else if (cmd === 'create') {
  const r = await apiPost(`/sections/${a1}/assignments`, { title: PROBE_TITLE, type: 'assignment', published: 0 });
  console.log('POST →', r.status, JSON.stringify({ id: r.data?.id, published: r.data?.published }));
  if (r.data?.id) await show('read back:', a1, r.data.id);
} else if (cmd === 'publish') {
  if (a3 !== '0' && a3 !== '1') throw new Error('value must be 0 or 1');
  await show('before:', a1, a2);
  const r = await apiPut(`/sections/${a1}/assignments/${a2}`, { published: Number(a3) });
  console.log(`PUT {published:${a3}} →`, r.status, r.data ? JSON.stringify(r.data).slice(0, 300) : '');
  await show('read back:', a1, a2);
} else if (cmd === 'rename') {
  const r = await apiPut(`/sections/${a1}/assignments/${a2}`, { title: PROBE_TITLE });
  console.log('PUT {title} →', r.status);
  await show('read back:', a1, a2);
} else if (cmd === 'delete') {
  await show('before:', a1, a2);
  const r = await apiDelete(`/sections/${a1}/assignments/${a2}`);
  console.log('DELETE →', r.status);
} else {
  console.log('usage: get|create|publish|rename|delete (see the header)');
}
