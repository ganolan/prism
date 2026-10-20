// Checks a Prism server's /mcp endpoint the way Claude Code reaches it (#131): lists the tools,
// calls list_courses, and reports whether the server is prod or a dev copy (a dev copy starts
// every tool result with its warning). Prints counts only, never course names.
//   node scripts/check-mcp-endpoint.js [url] [--expect-dev]
// url defaults to prod over the tailnet. Exit 0 when the endpoint answers and is what was
// expected: prod, or with --expect-dev a dev copy. Exit 1 when it does not answer, list_courses
// fails, or the endpoint is the other kind (a dev copy without --expect-dev, prod with it).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DEV_COPY_WARNING } from '../mcp/server.js';
import { isMain } from '../server/lib/isMain.js';

export const PROD_URL = 'https://prism.swordtail-everest.ts.net/mcp';

// Returns { ok, line }. Never throws: a failure is { ok: false, line: '<url>: <reason>' }.
export async function checkEndpoint(url = PROD_URL, { expectDev = false } = {}) {
  const client = new Client({ name: 'check-mcp-endpoint', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const { tools } = await client.listTools();
    const res = await client.callTool({ name: 'list_courses', arguments: {} });
    const texts = (res.content ?? []).map((c) => c.text ?? '');
    const dev = texts[0] === DEV_COPY_WARNING;
    const kind = dev ? 'dev copy' : 'prod';
    const courses = res.isError ? null : JSON.parse(dev ? texts[1] : texts[0]);
    const line = `${url}: ${tools.length} tools; list_courses ${courses ? `${courses.length} courses` : 'ERROR'}; ${kind}`;
    if (courses && dev !== expectDev) {
      return { ok: false, line: `${line} (expected ${expectDev ? 'a dev copy' : 'prod'})` };
    }
    return { ok: Boolean(courses), line };
  } catch (err) {
    return { ok: false, line: `${url}: ${err.message}` };
  } finally {
    await client.close().catch(() => {});
  }
}

if (isMain(import.meta.url)) {
  const url = process.argv.find((a) => /^https?:\/\//.test(a)) ?? PROD_URL;
  const { ok, line } = await checkEndpoint(url, { expectDev: process.argv.includes('--expect-dev') });
  (ok ? console.log : console.error)(line);
  process.exit(ok ? 0 : 1);
}
