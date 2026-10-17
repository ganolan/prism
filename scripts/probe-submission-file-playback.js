// Read-only probe for viewing native dropbox files inside Prism (#107 follow-up).
// For one assignment it takes the first file of each extension and reports:
//   - the converted copy Schoology lists (converted_* keys): its signed download's
//     status, type and whether its MD5 equals converted_md5_checksum;
//   - the redirect hop (host only, and whether the target URL carries a query);
//   - Range support on the redirect target and on the API path (status,
//     Accept-Ranges, Content-Range, bytes received);
//   - for video, the codec fourcc found in the file (avc1 / hvc1 / hev1 ...).
// No names, file names or contents are printed; ids are masked.
//
// Usage: node scripts/probe-submission-file-playback.js <sectionId> <assignmentId>
import 'dotenv/config';
import { createHash } from 'crypto';
import OAuth from 'oauth-1.0a';
import { apiGet, getSectionEnrollments } from '../server/services/schoology.js';

const [sectionId, aid] = process.argv.slice(2);
if (!sectionId || !aid) {
  console.error('usage: node scripts/probe-submission-file-playback.js <sectionId> <assignmentId>');
  process.exit(2);
}
const oauth = OAuth({
  consumer: { key: process.env.SCHOOLOGY_CONSUMER_KEY, secret: process.env.SCHOOLOGY_CONSUMER_SECRET },
  signature_method: 'PLAINTEXT',
});
const signed = (url) => oauth.toHeader(oauth.authorize({ url, method: 'GET' }, { key: '', secret: '' }));
const pathShape = (p) => String(p || '').replace(/^https:\/\/[^/]+/, '').replace(/\d+/g, 'N').replace(/[^/]+(\.[a-z0-9]+)$/i, '{name}$1');

// One signed hop on the API host → the redirect target (or the response itself).
async function hop(url, headers = {}) {
  const res = await fetch(url, { headers: { ...signed(url), ...headers }, redirect: 'manual' });
  const location = res.headers.get('location');
  return { res, location };
}
async function full(url) {
  const { res, location } = await hop(url);
  if (!location) return { status: res.status, type: res.headers.get('content-type'), body: Buffer.from(await res.arrayBuffer()) };
  await res.body?.cancel();
  const r2 = await fetch(location);
  return { status: r2.status, type: r2.headers.get('content-type'), body: Buffer.from(await r2.arrayBuffer()), location };
}
function codecs(buf) {
  const found = new Set();
  for (const cc of ['avc1', 'avc3', 'hvc1', 'hev1', 'mp4v', 'ap4h', 'apcn', 'mp4a', 'Opus']) if (buf.includes(cc)) found.add(cc);
  return [...found].join(',') || 'none found';
}
async function rangeCheck(label, url, headers = {}) {
  const res = await fetch(url, { headers: { Range: 'bytes=0-99', ...headers }, redirect: 'manual' });
  const body = Buffer.from(await res.arrayBuffer());
  console.log(`    range ${label}: status=${res.status} accept-ranges=${res.headers.get('accept-ranges')} content-range=${(res.headers.get('content-range') || '').replace(/\d+$/, (n) => n)} bytes=${body.length} type=${res.headers.get('content-type')} cache-control=${res.headers.get('cache-control')}`);
}

const students = (await getSectionEnrollments(sectionId)).filter((e) => String(e.admin) !== '1' && String(e.status) === '1');
const byExt = new Map();
let videoUid = null;
for (const s of students) {
  const d = await apiGet(`/sections/${sectionId}/submissions/${aid}/${s.uid}?with_attachments=1`);
  for (const r of d.revision || []) {
    for (const f of r.attachments?.files?.file || []) {
      if (!byExt.has(f.extension)) byExt.set(f.extension, f);
      if (!videoUid && f.filemime?.startsWith('video/')) videoUid = s.uid;
    }
  }
  if (byExt.size >= 3) break;
}

// WEB=1: what the teacher's dropbox view page (plain HTTP, saved session) offers
// for a video submission: counts of player markup and file URLs, no values.
if (process.env.WEB && videoUid) {
  const { cookieJar, getPage } = await import('../server/services/schoologyWeb.js');
  const jar = cookieJar();
  const page = await getPage(jar, `/assignment/${aid}/dropbox/view/${videoUid}`);
  const count = (re) => (page.html.match(re) || []).length;
  console.log(`dropbox view page: ${page.html.length} chars; <video ${count(/<video\b/gi)}, <source ${count(/<source\b/gi)}, <iframe ${count(/<iframe\b/gi)}, ` +
    `"/conversion/" ${count(/\/conversion\//g)}, ".mp4" ${count(/\.mp4\b/gi)}, files-cdn ${count(/files-cdn\.schoology\.com/g)}, ` +
    `"/attachment/" ${count(/\/attachment\/\d+/g)}, jwplayer ${count(/jwplayer/gi)}, videojs ${count(/video-?js/gi)}, kaltura ${count(/kaltura/gi)}`);
  const hrefs = [...page.html.matchAll(/(?:href|src|data-[a-z-]+)="([^"]*(?:attachment|conversion|submission|files-cdn|\.mp4|\.mov)[^"]*)"/gi)].map((m) => m[1]);
  console.log(`  file-ish URL shapes: ${[...new Set(hrefs.map((h) => h.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '?…').replace(/\d+/g, 'N').replace(/[^/]+(\.[a-z0-9]+)(\?…)?$/i, '{name}$1$2')))].join(' | ') || 'none'}`);
}

for (const [ext, f] of byExt) {
  console.log(`\n.${ext} (${f.filemime}, ${f.filesize} bytes) converted_status=${f.converted_status} converted_type=${f.converted_type} converted=${f.converted_extension ?? 'none'} (${f.converted_filemime ?? '-'}, ${f.converted_filesize ?? '-'} bytes)`);
  const { res, location } = await hop(f.download_path);
  await res.body?.cancel();
  const target = location ? new URL(location) : null;
  console.log(`  original: signed hop ${res.status} → ${target ? `${target.origin}${pathShape(target.pathname)} query=${target.search ? [...target.searchParams.keys()].join('+') : 'none'}` : 'no redirect'}`);
  if (target) {
    await rangeCheck('on redirect target', location);
    // A second request to the same target without Range: is the URL reusable?
    const again = await fetch(location, { method: 'HEAD' });
    console.log(`    HEAD redirect target: status=${again.status} length=${again.headers.get('content-length')} type=${again.headers.get('content-type')}`);
  }
  await rangeCheck('on API path (signed, manual redirect)', f.download_path, signed(f.download_path));
  if (f.filemime?.startsWith('video/')) {
    const o = await full(f.download_path);
    console.log(`  original codecs: ${codecs(o.body)} md5Match=${createHash('md5').update(o.body).digest('hex') === f.md5_checksum}`);
  }
  if (f.converted_download_path) {
    console.log(`  converted path shape: ${pathShape(f.converted_download_path)} (host ${new URL(f.converted_download_path).host})`);
    const c = await full(f.converted_download_path);
    const md5 = createHash('md5').update(c.body).digest('hex');
    console.log(`  converted download: status=${c.status} type=${c.type} bytes=${c.body.length} md5Match=${md5 === f.converted_md5_checksum}${f.converted_filemime?.startsWith('video/') ? ` codecs=${codecs(c.body)}` : ''}`);
    if (c.location) await rangeCheck('on converted redirect target', (await hop(f.converted_download_path)).location);
  }
}
