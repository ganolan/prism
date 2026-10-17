// Read-only probe for #141: GET school-domain paths over plain HTTP with the saved
// session's cookies (server/services/schoologyWeb.js), no browser, and print the
// status, content type, time and a masked shape summary of each answer.
// Refuses any path holding "unsubmit" or "delete" (GET-href write actions).
// Usage (repo root): node scripts/probe-web-http-reads.js <path> [<path>...]
//   e.g. /iapi2/assignments/123/submitted-documents/
import { cookieJar, getResource, drupalSettings } from '../server/services/schoologyWeb.js';

const paths = process.argv.slice(2);
if (!paths.length) { console.error('Usage: node scripts/probe-web-http-reads.js <path> [<path>...]'); process.exit(1); }
const jar = cookieJar();
if (!jar) { console.error('No saved session (.playwright-session/storage-state.json)'); process.exit(1); }

const mask = (p) => p.replace(/\d{5,}/g, (d) => `…${d.slice(-3)}`);
const shape = (v, depth = 0) => {
  if (Array.isArray(v)) return `array(${v.length})${v.length && depth < 2 ? ` of ${shape(v[0], depth + 1)}` : ''}`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    return depth >= 2 ? `{${keys.length} keys}` : `{${keys.slice(0, 12).map((k) => (/^\d+$/.test(k) ? '<id>' : k)).join(', ')}${keys.length > 12 ? ', …' : ''}}`;
  }
  return typeof v;
};

for (const path of paths) {
  if (/unsubmit|delete/i.test(path)) { console.log(`${mask(path)}: refused (write-action URL)`); continue; }
  const t = Date.now();
  try {
    const r = await getResource(jar, path, { accept: 'application/json' });
    let summary;
    try { summary = shape(JSON.parse(r.text)); } catch { summary = `non-JSON ${r.text.length} bytes`; }
    const limits = [...r.headers].filter(([k]) => /retry-after|ratelimit|rate-limit/i.test(k)).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`${mask(path)}: ${r.status} ${r.contentType || ''} ${Date.now() - t} ms ${summary}${limits ? ` [${limits}]` : ''}`);
    // SETTINGS=1: the page's merged Drupal.settings, top-level keys only, and whether the CSRF pair is there.
    if (process.env.SETTINGS) {
      const s = drupalSettings(r.text);
      console.log(`  Drupal.settings: ${s ? Object.keys(s).length : 0} keys; s_common CSRF pair: ${Boolean(s?.s_common?.csrf_token && s?.s_common?.csrf_key)}; s_attachment: ${Boolean(s?.s_attachment)}`);
    }
    // GREP=<regex>: where the answer mentions it (40 characters either side, digit runs masked).
    if (process.env.GREP) {
      const re = new RegExp(process.env.GREP, 'gi');
      let n = 0;
      for (const m of r.text.matchAll(re)) {
        if (n++ >= 8) break;
        console.log(`  …${r.text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).replace(/\s+/g, ' ').replace(/\d{5,}/g, (d) => `<${d.length} digits …${d.slice(-3)}>`)}…`);
      }
      console.log(`  ${[...r.text.matchAll(re)].length} match(es) for /${process.env.GREP}/`);
    }
    if (r.status === 429 && process.env.SHOW_429) console.log([...r.headers].map(([k, v]) => `  ${k}: ${k === 'set-cookie' ? '<…>' : v}`).join('\n'), `\n  body: ${r.text.slice(0, 200).replace(/\s+/g, ' ')}`);
  } catch (err) {
    console.log(`${mask(path)}: ${err.code || 'ERROR'} ${err.message} (${Date.now() - t} ms)`);
  }
}
