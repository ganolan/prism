// Resolve a reporting-category title to a fill colour using a config palette
// keyed by lowercase keyword (e.g. {produce:'#B4A7D6', create:'#9FC5E8'}).
// Keyword-contains match keeps it subject-agnostic; unknown → neutral.
export function categoryColor(categoryTitle, palette = {}) {
  const t = (categoryTitle || '').toLowerCase();
  for (const [key, color] of Object.entries(palette)) {
    if (t.includes(key.toLowerCase())) return color;
  }
  return 'var(--bg-subtle)';
}
