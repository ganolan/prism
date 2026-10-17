// A stand-in for Schoology's web surface over HTTP (server/services/schoologyWeb.js):
// the dropbox view page, the plupload upload endpoint and the AJAX form post,
// plus any GET routes a test lists (the /iapi and /iapi2 JSON reads, pages).
// Records every request; never reaches the network.
export const VIEW_HTML = ({ formAction = '/assignment/A/dropbox/view/U' } = {}) => `<html><head>
<script type="text/javascript">
<!--//--><![CDATA[//><!--
jQuery.extend(Drupal.settings, {"s_common":{"csrf_token":"tok","csrf_key":"key"},"s_attachment":{"upload_url":"/s_attachment_upload_chunked/2","chunk_size":70000}});
//--><!]]>
</script></head><body>
<form action="${formAction}" accept-charset="UTF-8" method="post" id="s-drop-item-add-comment-form" enctype="multipart/form-data">
<textarea cols="60" rows="5" name="comment" id="edit-comment"></textarea>
<input type="hidden" name="target_DOM_id" id="edit-target-DOM-id" value="upload-btn-1" />
<input type="hidden" name="sid" id="edit-sid" value="s&amp;1" />
<input type="hidden" name="file[files]" id="edit-file-files" value="" />
<input type="hidden" name="file[recording]" id="edit-file-recording" value="" />
<input type="hidden" name="annotation_files" id="edit-annotation-files" value="" />
<input type="submit" name="op" id="edit-submit" value="Post" class="form-submit" />
<input type="hidden" name="form_build_id" id="form-abc" value="form-abc" />
<input type="hidden" name="form_token" id="edit-token" value="ftok" />
<input type="hidden" name="form_id" id="edit-s-drop-item-add-comment-form" value="s_drop_item_add_comment_form" />
</form></body></html>`;

// `routes` answers other GETs: { '/iapi2/x/': spec | (entry) => spec } keyed by
// pathname, where spec is { status = 200, json, headers? } | { status, text, headers? } | { login: true }
// (a 302 to sign-in) | { throws: Error } (the request fails outright). entry
// carries the query string as `query` (URLSearchParams).
export function fakeSchoologyWeb({ html = VIEW_HTML(), loginRedirect = false, uploadAnswer, onSubmit, routes = {} } = {}) {
  const requests = [];
  const answer = (status, body, headers = {}) => new Response(body, { status, headers });
  async function fetchImpl(url, opts = {}) {
    const u = new URL(url);
    const entry = { method: opts.method || 'GET', path: u.pathname, query: u.searchParams, headers: opts.headers || {}, body: opts.body };
    requests.push(entry);
    if (entry.method === 'GET' && Object.hasOwn(routes, u.pathname)) {
      const route = routes[u.pathname];
      const spec = typeof route === 'function' ? await route(entry) : route;
      if (spec.throws) throw spec.throws;
      if (spec.login) return answer(302, '', { location: 'https://login.microsoftonline.com/x' });
      if ('json' in spec) return answer(spec.status ?? 200, JSON.stringify(spec.json), { 'content-type': 'application/json', ...spec.headers });
      return answer(spec.status ?? 200, spec.text ?? '', { 'content-type': 'text/html', ...spec.headers });
    }
    if (entry.method === 'GET' && u.pathname.includes('/dropbox/view/')) {
      if (loginRedirect) return answer(302, '', { location: 'https://login.microsoftonline.com/x' });
      return answer(200, html, { 'set-cookie': 'SESS=new; path=/' });
    }
    if (entry.method === 'POST' && u.pathname === '/s_attachment_upload_chunked/2') {
      entry.form = Object.fromEntries([...opts.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `<blob ${v.size}>`]));
      return uploadAnswer ? uploadAnswer(entry) : answer(200, JSON.stringify({ file: { fid: 4242 } }));
    }
    if (entry.method === 'POST' && u.pathname.includes('/dropbox/view/')) {
      entry.form = Object.fromEntries(new URLSearchParams(opts.body));
      onSubmit?.(entry);
      return answer(200, JSON.stringify([{ command: 'settings' }]), { 'content-type': 'application/json' });
    }
    return answer(404, 'not faked');
  }
  const jar = { cookies: 'SESS=old', header() { return this.cookies; }, take(res) { const c = res.headers.get('set-cookie'); if (c) this.cookies = c.split(';')[0]; } };
  return { requests, fetchImpl, jar };
}
