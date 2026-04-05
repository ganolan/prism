/**
 * PowerSchool API Probe
 *
 * Tests whether the PowerSchool server has an accessible API surface.
 * No credentials needed — just probes public/semi-public endpoints.
 *
 * Usage: node test-powerschool-probe.js
 */

const BASE = 'https://powerschool.hkis.edu.hk';

async function probe(label, url, opts = {}) {
  process.stdout.write(`  ${label.padEnd(50)} `);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body || undefined,
      signal: controller.signal,
      redirect: 'manual',
    });
    clearTimeout(timeout);

    const contentType = res.headers.get('content-type') || '';
    let body = '';
    try {
      body = await res.text();
      if (body.length > 500) body = body.substring(0, 500) + '...';
    } catch {}

    const icon = res.status < 300 ? '✅' :
                 res.status < 400 ? '↗️ ' :
                 res.status === 401 ? '🔑' :
                 res.status === 403 ? '🔒' :
                 res.status === 404 ? '❌' :
                 `⚡`;

    console.log(`${icon} ${res.status} (${contentType.split(';')[0]})`);

    if (res.status < 400 || res.status === 401) {
      // Show useful details
      if (body && body.length > 0 && body.length < 500) {
        console.log(`    → ${body}`);
      }
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      console.log(`    → Redirects to: ${res.headers.get('location')}`);
    }

    return { status: res.status, body, contentType };
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log(`⏱️  TIMEOUT (10s)`);
    } else {
      console.log(`💥 ${err.code || err.message}`);
    }
    return { status: -1, error: err.message };
  }
}

async function run() {
  console.log(`PowerSchool API Probe`);
  console.log(`Target: ${BASE}`);
  console.log('');

  // ── 1. Basic connectivity ──
  console.log('── Connectivity ──');
  await probe('GET / (homepage)', `${BASE}/`);
  await probe('GET /admin/home.html', `${BASE}/admin/home.html`);

  // ── 2. API metadata (often public) ──
  console.log('\n── API Metadata ──');
  await probe('GET /ws/v1/metadata', `${BASE}/ws/v1/metadata`);
  await probe('GET /ws/v1/schema', `${BASE}/ws/v1/schema`);
  await probe('GET /ws/schema', `${BASE}/ws/schema`);
  await probe('GET /ws/v1/district', `${BASE}/ws/v1/district`);

  // ── 3. OAuth endpoint probe ──
  console.log('\n── OAuth Token Endpoint ──');
  // Try with dummy credentials to see if endpoint exists
  const dummyAuth = Buffer.from('test_client_id:test_client_secret').toString('base64');
  await probe('POST /oauth/access_token (dummy creds)',
    `${BASE}/oauth/access_token`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${dummyAuth}`,
      },
      body: 'grant_type=client_credentials',
    }
  );

  // ── 4. Public/legacy API endpoints ──
  console.log('\n── Legacy/Public API Paths ──');
  await probe('GET /ws/v1/school', `${BASE}/ws/v1/school`);
  await probe('GET /ws/v1/school/count', `${BASE}/ws/v1/school/count`);
  await probe('GET /public/', `${BASE}/public/`);
  await probe('GET /api/v1/', `${BASE}/api/v1/`);

  // ── 5. PowerQuery endpoints ──
  console.log('\n── PowerQuery ──');
  await probe('GET /ws/schema/query/api', `${BASE}/ws/schema/query/api`);
  await probe('POST /ws/schema/query/api (empty)',
    `${BASE}/ws/schema/query/api`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
  );

  // ── 6. OpenID / SSO endpoints ──
  console.log('\n── SSO / OpenID ──');
  await probe('GET /openid/provider/', `${BASE}/openid/provider/`);
  await probe('GET /.well-known/openid-configuration', `${BASE}/.well-known/openid-configuration`);

  // ── 7. SAML / federation ──
  console.log('\n── SAML / Federation ──');
  await probe('GET /sp/metadata', `${BASE}/sp/metadata`);

  // ── Summary ──
  console.log('\n── Interpretation ──');
  console.log(`
Key signals:
  🔑 401 on /oauth/access_token = endpoint exists, just need valid credentials
  ❌ 404 on /oauth/access_token = OAuth not configured, no plugin installed
  🔒 403 on /ws/v1/* = API exists but needs auth
  ✅ 200 on /ws/v1/metadata = API is open and accessible
  ↗️  302 on most paths = likely redirecting to SSO login
  💥 connection errors = server not reachable or API port blocked
`);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
