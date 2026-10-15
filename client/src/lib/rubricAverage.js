// Copy of server/lib/rubricAverage.js (the client cannot import server code).
// rubricAverage.cases.json runs against both copies: keep them in step.
export function rubricAverage(scale, rowNames, levelsByName) {
  if (!scale || !rowNames?.length) return { level: null, reason: 'incomplete' };
  const values = rowNames.map((n) => levelsByName?.[n] ?? null);
  if (values.includes('IE')) return { level: null, reason: 'insufficient_evidence' };
  const points = values.map((v) => (v == null ? null : scale.levels.find((l) => l.code === v)?.points ?? null));
  if (points.some((p) => p == null)) return { level: null, reason: 'incomplete' };
  const mean = points.reduce((a, b) => a + b, 0) / points.length;
  const byCutoff = [...scale.levels].sort((a, b) => b.cutoff - a.cutoff);
  return { level: byCutoff.find((l) => mean >= l.cutoff)?.code ?? null, reason: null };
}
