// PrisMCP over HTTP (#131): the tools of mcp/server.js, served from this process at /mcp with
// the MCP SDK's streamable HTTP transport. Stateless: each POST builds its own MCP server and
// transport and answers that one request (the answer streams as SSE, so a long
// get_assignment_context can send progress notifications), so a restart or deploy ends no
// client's session. The tools use this process's database connection, sync queue and saved
// Schoology session.
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { createServer } from '../../mcp/server.js';
import { originGuard } from '../middleware/originGuard.js';

const jsonRpcError = (code, message) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

// allowedHosts: hostnames without a port (hostHeaderValidation compares the hostname only),
// so a web page cannot reach this through a name it controls (DNS rebinding).
export function mcpRouter({ allowedHosts, devCopy = false }) {
  const router = express.Router();
  router.use(hostHeaderValidation(allowedHosts));
  // A tool call can carry a file or a long text; the default 100 KB would refuse it.
  router.use(express.json({ limit: '25mb' }));

  router.post('/', async (req, res) => {
    const server = createServer({ devCopy });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: false });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] request failed:', err);
      if (!res.headersSent) res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
    }
  });

  // Stateless: there is no stream to resume and no session to end.
  const notAllowed = (req, res) => {
    res.set('Allow', 'POST').status(405).json(jsonRpcError(-32000, 'Method not allowed: this server is stateless, POST each request'));
  };
  router.get('/', notAllowed);
  router.delete('/', notAllowed);

  // express.json's parse errors (and any other) answer as JSON-RPC, not an HTML page.
  router.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status && err.status < 500 ? err.status : 500;
    res.status(status).json(jsonRpcError(status === 500 ? -32603 : -32700, status === 500 ? 'Internal server error' : 'Parse error'));
  });
  return router;
}

// Mount /mcp on `app` with the same guard as /api (originGuard refuses another site's POST) plus
// the Host check. Called by server/index.js before the SPA fallback, and by the tests on a fresh
// app, so both run the same chain. `allowedOrigins`: config.yaml server.allowedOrigins.
export function mountMcp(app, { allowedOrigins = [], devCopy = false } = {}) {
  // A malformed entry is skipped with a warning, so one typo in config.yaml cannot stop the server booting.
  const originHosts = allowedOrigins.flatMap((o) => {
    try { return [new URL(o).hostname]; } catch {
      console.warn(`[mcp] ignoring server.allowedOrigins entry ${JSON.stringify(o)}: not a valid URL (it is not an allowed Host for /mcp)`);
      return [];
    }
  });
  const allowedHosts = ['127.0.0.1', 'localhost', ...originHosts];
  app.use('/mcp', originGuard({ allowed: allowedOrigins }), mcpRouter({ allowedHosts, devCopy }));
}
