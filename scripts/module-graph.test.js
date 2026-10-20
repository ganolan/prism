// Import-graph guards (#170): a leaf module stays a leaf, the sync queue has no import cycle, and
// the endpoint check script loads no database. Reads the static `import` / `export ... from`
// lines of the source (dynamic import() is not followed), so nothing here loads a module.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FROM = /^\s*(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|^\s*import\s*['"](\.[^'"]+)['"]/gm;

// The project files a file imports directly (relative specifiers only).
function importsOf(file) {
  const src = readFileSync(file, 'utf8');
  const out = [];
  for (const m of src.matchAll(FROM)) {
    const target = resolve(dirname(file), m[1] ?? m[2]);
    if (existsSync(target)) out.push(target);
  }
  return out;
}

// Every file reachable from `file` through imports, `file` itself excluded unless it is in a cycle.
function reachable(file) {
  const seen = new Set();
  const walk = (f) => { for (const t of importsOf(f)) if (!seen.has(t)) { seen.add(t); walk(t); } };
  walk(file);
  return seen;
}

const at = (p) => resolve(ROOT, p);
const names = (set) => [...set].map((f) => relative(ROOT, f));

describe('module graph', () => {
  it('the shared constants live in leaf modules that import nothing', () => {
    expect(importsOf(at('server/lib/toolWait.js'))).toEqual([]);
    expect(importsOf(at('mcp/devCopy.js'))).toEqual([]);
  });

  it('the quiz run and the grading sync take TOOL_WAIT_MS from the leaf; the queue no longer defines it', () => {
    for (const f of ['server/services/quizRun.js', 'server/services/gradingSync.js']) {
      expect(names(new Set(importsOf(at(f)))), f).toContain('server/lib/toolWait.js');
    }
    expect(readFileSync(at('server/services/syncQueue.js'), 'utf8')).not.toMatch(/TOOL_WAIT_MS\s*=/);
  });

  it('no module the sync queue imports imports the queue back', () => {
    const queue = at('server/services/syncQueue.js');
    const cyclic = importsOf(queue).filter((dep) => reachable(dep).has(queue));
    expect(names(new Set(cyclic))).toEqual([]);
  });

  it('check-mcp-endpoint.js loads no database module and not the PrisMCP server', () => {
    const graph = names(reachable(at('scripts/check-mcp-endpoint.js')));
    expect(graph).not.toContain('server/db/index.js');
    expect(graph).not.toContain('mcp/server.js');
    expect(graph).not.toContain('mcp/handlers.js');
    expect(graph).toContain('mcp/devCopy.js');
  });
});
