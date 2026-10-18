// The Student Support Summary pop-up (#163): PowerSchool's MBA custom-alerts dialog
// for alert 11290981 (`url=mbapop_studentsupportsummary.html`). Probed 18/10/2026: a
// two-column table, headers Category | Description, rows Academic Support,
// SEL/Behavioral Support, Case Manager, Accommodation Plan, TLI, Intervention Plan,
// ILP, Support Plan URL, Support Notes (.claude/powerschool-api-reference.md
// "Alert pop-ups"). Read as text, verbatim; nothing is inferred from it.
const decode = (v) => v
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const text = (html) => decode(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// → [{ category, description, url? }] in page order; [] when the page has no rows.
export function parseSupportSummary(html) {
  const rows = [];
  for (const [, tr] of String(html || '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length < 2) continue; // the header row is <th>s
    const row = { category: text(cells[0]), description: text(cells[1]) };
    const href = cells[1].match(/<a\b[^>]*href="([^"]+)"/i)?.[1];
    if (href) row.url = decode(href);
    if (row.category) rows.push(row);
  }
  return rows;
}

// A made-up page in the probed shape, for tests and the fakes (no real values).
export const SUPPORT_SUMMARY_HTML = `<div class="box-round"><table class="grid">
<thead><tr><th>Category</th><th>Description</th></tr></thead><tbody>
<tr><td>Academic Support</td><td>Y</td></tr>
<tr><td>SEL/Behavioral Support</td><td>Tier 2</td></tr>
<tr><td>Case Manager</td><td>-</td></tr>
<tr><td>Accommodation Plan</td><td>Yes</td></tr>
<tr><td>TLI</td><td>No</td></tr>
<tr><td>Intervention Plan</td><td>-</td></tr>
<tr><td>ILP</td><td>-</td></tr>
<tr><td>Support Plan URL</td><td><a href="https://example.org/plan" target="_blank">Open plan</a></td></tr>
<tr><td>Support Notes</td><td>25% extra time on tests &amp; quizzes; seat near the front.</td></tr>
</tbody></table></div>`;
