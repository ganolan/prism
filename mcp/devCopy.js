// The warning a dev copy of Prism puts at the head of every PrisMCP tool result (mcp/server.js).
// A leaf module with no imports, so scripts/check-mcp-endpoint.js can know the text without
// loading the server and its database.
export const DEV_COPY_WARNING =
  'This is a dev copy of Prism: its data is replaced at the next refresh, and it refuses Schoology writes.';
