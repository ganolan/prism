import { describe, test, expect } from 'vitest';
import { drupalSettings, formFields, uploadAttachment, getPage } from './schoologyWeb.js';
import { VIEW_HTML, fakeSchoologyWeb } from '../testing/fakeSchoologyWeb.js';

describe('schoologyWeb parsing', () => {
  test('reads Drupal.settings from the page', () => {
    expect(drupalSettings(VIEW_HTML())).toMatchObject({ s_common: { csrf_token: 'tok' }, s_attachment: { chunk_size: 70000 } });
    expect(drupalSettings('<html></html>')).toBeNull();
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

describe('getPage', () => {
  test('a redirect to sign-in is SESSION_EXPIRED', async () => {
    const web = fakeSchoologyWeb({ loginRedirect: true });
    await expect(getPage(web.jar, '/assignment/1/dropbox/view/2', { fetchImpl: web.fetchImpl })).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
  });
});
