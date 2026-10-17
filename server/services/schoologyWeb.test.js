import { describe, test, expect } from 'vitest';
import { drupalSettings, formFields, uploadAttachment, getPage, getResource, getJson, postJson } from './schoologyWeb.js';
import { VIEW_HTML, fakeSchoologyWeb } from '../testing/fakeSchoologyWeb.js';

describe('schoologyWeb parsing', () => {
  test('reads Drupal.settings from the page', () => {
    expect(drupalSettings(VIEW_HTML())).toMatchObject({ s_common: { csrf_token: 'tok' }, s_attachment: { chunk_size: 70000 } });
    expect(drupalSettings('<html></html>')).toBeNull();
  });
  test('merges every Drupal.settings block, in page order, in the real `}); //--><!]]> </script>` form', () => {
    const block = (o) => `<script type="text/javascript"> <!--//--><![CDATA[//><!-- jQuery.extend(Drupal.settings, ${JSON.stringify(o)}); //--><!]]> </script>`;
    const html = `<html>${block({ basePath: '/', a: 1 })}<p>x</p>${block({ s_common: { csrf_token: 't', csrf_key: 'k' }, a: 2 })}</html>`;
    expect(drupalSettings(html)).toEqual({ basePath: '/', a: 2, s_common: { csrf_token: 't', csrf_key: 'k' } });
    expect(drupalSettings(`<script>jQuery.extend(Drupal.settings, {"x":1});</script>`)).toEqual({ x: 1 });
    expect(drupalSettings(`<script>jQuery.extend(Drupal.settings, {not json});</script>`)).toBeNull();
  });
  test('reads one form: hidden fields decoded, the textarea, the submit button', () => {
    const f = formFields(VIEW_HTML(), 's-drop-item-add-comment-form');
    expect(f.submit).toEqual({ name: 'op', value: 'Post' });
    expect(f.inputs).toMatchObject({ sid: 's&1', 'file[files]': '', comment: '', form_id: 's_drop_item_add_comment_form' });
    expect(formFields(VIEW_HTML(), 'other-form')).toBeNull();
  });
});

describe('uploadAttachment', () => {
  test('sends chunks of chunk_size KB, carrying the first fid on later chunks', async () => {
    const web = fakeSchoologyWeb();
    const settings = { s_common: { csrf_token: 't', csrf_key: 'k' }, s_attachment: { upload_url: '/s_attachment_upload_chunked/2', chunk_size: 1 } };
    const fid = await uploadAttachment(web.jar, settings, { name: 'a.bin', bytes: Buffer.alloc(2500) }, { fetchImpl: web.fetchImpl });
    expect(fid).toBe('4242');
    expect(web.requests.map((r) => [r.form.chunk, r.form.chunks, r.form.fid, r.form.file])).toEqual([
      ['0', '3', undefined, '<blob 1024>'], ['1', '3', '4242', '<blob 1024>'], ['2', '3', '4242', '<blob 452>'],
    ]);
  });
});

describe('getResource / getJson', () => {
  test('a non-200 is an answer, not an error; JSON is parsed when it is JSON', async () => {
    const web = fakeSchoologyWeb({ routes: { '/iapi2/a/': { status: 403, json: { data: null } }, '/iapi2/b/': { text: '<html>' } } });
    expect(await getJson(web.jar, '/iapi2/a/', { fetchImpl: web.fetchImpl })).toMatchObject({ status: 403, json: { data: null } });
    expect(await getJson(web.jar, '/iapi2/b/', { fetchImpl: web.fetchImpl })).toMatchObject({ status: 200, json: null });
    expect(web.requests[0].headers).toMatchObject({ Accept: 'application/json', cookie: 'SESS=old' });
    const page = await getResource(web.jar, '/iapi2/b/', { fetchImpl: web.fetchImpl });
    expect(page).toMatchObject({ status: 200, text: '<html>', url: 'https://schoology.hkis.edu.hk/iapi2/b/' });
    expect(web.requests[2].headers.Accept).toBeUndefined();
  });
  test('a 429 is waited out (Retry-After, capped at 10 s; else 2 s then 4 s) and asked again; the last 429 is the answer', async () => {
    let n = 0;
    const web = fakeSchoologyWeb({ routes: {
      '/a/': () => (++n === 1 ? { status: 429, text: '', headers: { 'retry-after': '3' } } : { json: { ok: 1 } }),
      '/b/': { status: 429, text: 'slow down' },
    } });
    const waits = [];
    const sleep = async (ms) => { waits.push(ms); };
    expect(await getJson(web.jar, '/a/', { fetchImpl: web.fetchImpl, sleep })).toMatchObject({ status: 200, json: { ok: 1 } });
    expect(waits).toEqual([3000]);
    waits.length = 0;
    expect(await getResource(web.jar, '/b/', { fetchImpl: web.fetchImpl, sleep })).toMatchObject({ status: 429, text: 'slow down' });
    expect(waits).toEqual([2000, 4000]);
    expect(await getResource(web.jar, '/b/', { fetchImpl: web.fetchImpl, sleep, retries429: 0 })).toMatchObject({ status: 429 });
  });
  test('a failed or timed-out request is an HTTP error; a sign-in bounce is SESSION_EXPIRED', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const web = fakeSchoologyWeb({ routes: { '/t/': { throws: timeout }, '/l/': { login: true } } });
    await expect(getResource(web.jar, '/t/', { fetchImpl: web.fetchImpl })).rejects.toMatchObject({ code: 'HTTP', message: expect.stringContaining('timed out') });
    await expect(getJson(web.jar, '/l/', { fetchImpl: web.fetchImpl })).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
  });
});

describe('postJson', () => {
  const csrf = { csrf_token: 't', csrf_key: 'k' };
  test('a JSON POST with the CSRF pair and X-Requested-With; any status is an answer', async () => {
    const web = fakeSchoologyWeb({ routes: { 'POST /api/search': (e) => ({ status: e.json.q === 1 ? 200 : 403, json: { data: e.json.q === 1 ? [1] : null } }) } });
    expect(await postJson(web.jar, '/api/search', { q: 1 }, { csrf, fetchImpl: web.fetchImpl })).toMatchObject({ status: 200, json: { data: [1] } });
    expect(await postJson(web.jar, '/api/search', { q: 2 }, { csrf, fetchImpl: web.fetchImpl })).toMatchObject({ status: 403, json: { data: null } });
    expect(web.requests[0].headers).toMatchObject({ cookie: 'SESS=old', 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': 't', 'X-CSRF-Key': 'k' });
  });
  test('no CSRF pair: refused before sending; a redirect to sign-in is SESSION_EXPIRED', async () => {
    const web = fakeSchoologyWeb({ routes: { 'POST /api/search': { login: true } } });
    await expect(postJson(web.jar, '/api/search', {}, { csrf: {}, fetchImpl: web.fetchImpl })).rejects.toMatchObject({ code: 'NO_CSRF' });
    expect(web.requests).toHaveLength(0);
    await expect(postJson(web.jar, '/api/search', {}, { csrf, fetchImpl: web.fetchImpl })).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
  });
});

describe('getPage', () => {
  test('a redirect to sign-in is SESSION_EXPIRED', async () => {
    const web = fakeSchoologyWeb({ loginRedirect: true });
    await expect(getPage(web.jar, '/assignment/1/dropbox/view/2', { fetchImpl: web.fetchImpl })).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
  });
});
