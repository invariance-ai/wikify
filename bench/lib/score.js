// Scoring helpers shared by the benchmarks. No dependencies.

// Precision / recall / F1 for a set of predicted findings vs. expected ones.
// `matched(expected, predicted)` decides whether a prediction satisfies an
// expectation (e.g. same file + overlapping line + matching category).
export function prf1(expected, predicted, matched) {
  const usedPred = new Set();
  let tp = 0;
  for (const e of expected) {
    const hit = predicted.findIndex((p, i) => !usedPred.has(i) && matched(e, p));
    if (hit !== -1) { tp += 1; usedPred.add(hit); }
  }
  const fp = predicted.length - usedPred.size;
  const fn = expected.length - tp;
  const precision = predicted.length ? tp / predicted.length : (expected.length ? 0 : 1);
  const recall = expected.length ? tp / expected.length : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, fp, fn, precision, recall, f1 };
}

export function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

// Render a list of { name, metrics } rows as a fixed-width scorecard.
export function scorecard(title, rows) {
  const lines = [];
  lines.push("");
  lines.push(`══ ${title} ${"═".repeat(Math.max(0, 46 - title.length))}`);
  for (const r of rows) {
    lines.push(`  ${r.name.padEnd(28)} ${r.value}`);
  }
  return lines.join("\n");
}
