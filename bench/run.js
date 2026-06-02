#!/usr/bin/env node
// Benchmark runner. Executes the three benchmark dimensions and prints a
// combined scorecard. Run with: npm run bench
//
//   1. review-quality   precision/recall of the reviewer on seeded-bug fixtures
//   2. ledger-accuracy  does .wiki/tests.md stay correct across simulated PRs
//   3. e2e-prs          the whole pipeline on real merged PRs (opt-in manifest)
//
// Select the reviewer for (1) and (3) with WIKIFY_REVIEWER (default: baseline).
import { run as reviewQuality } from "./benchmarks/review-quality.js";
import { run as ledgerAccuracy } from "./benchmarks/ledger-accuracy.js";
import { run as e2ePrs } from "./benchmarks/e2e-prs.js";
import { pct } from "./lib/score.js";

const results = [reviewQuality(), ledgerAccuracy(), e2ePrs()];
for (const r of results) console.log(r.report);

console.log("\n══ Summary ════════════════════════════════════");
for (const r of results) {
  const s = r.skipped ? `skipped (${r.skipped})` : pct(r.score);
  console.log(`  ${r.name.padEnd(20)} ${s}`);
}

const scored = results.filter((r) => typeof r.score === "number");
const overall = scored.length ? scored.reduce((a, r) => a + r.score, 0) / scored.length : 0;
console.log(`  ${"OVERALL".padEnd(20)} ${pct(overall)}  (mean of ${scored.length} scored)`);
console.log("");
