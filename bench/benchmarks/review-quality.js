// Benchmark 1 — review quality. Runs the selected reviewer over seeded-bug
// fixtures and scores precision/recall/F1. A prediction matches an expectation
// when the category is equal and the line is within ±2.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prf1, pct, scorecard } from "../lib/score.js";
import { getReviewer } from "../reviewers/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function run() {
  const reviewer = getReviewer();
  const { cases } = JSON.parse(fs.readFileSync(path.join(HERE, "..", "fixtures", "review.json"), "utf8"));
  const matched = (e, p) => e.category === p.category && Math.abs(e.line - p.line) <= 2;

  let expected = [], predicted = [];
  for (const c of cases) {
    expected.push(...c.expected.map((e) => ({ ...e, file: c.file })));
    predicted.push(...reviewer.review({ file: c.file, code: c.code }));
  }
  const m = prf1(expected, predicted, matched);
  const report = scorecard(`Review quality — reviewer: ${reviewer.name}`, [
    { name: "cases", value: String(cases.length) },
    { name: "expected findings", value: String(expected.length) },
    { name: "true / false positives", value: `${m.tp} / ${m.fp}` },
    { name: "precision", value: pct(m.precision) },
    { name: "recall", value: pct(m.recall) },
    { name: "F1", value: pct(m.f1) },
  ]);
  return { name: "review-quality", metrics: m, score: m.f1, report };
}
