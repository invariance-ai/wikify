// Benchmark 3 — end-to-end on real merged PRs. Reads fixtures/prs.json, fetches
// each PR's diff via `gh`, runs the selected reviewer over the changed files,
// and scores precision/recall against ground-truth findings. Skips cleanly when
// the manifest is empty or `gh` is unavailable, so the suite stays runnable.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prf1, pct, scorecard } from "../lib/score.js";
import { getReviewer } from "../reviewers/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function ghAvailable() {
  try { execFileSync("gh", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

// Fetch a PR's changed files as [{ file, code }] (post-image of the patch).
function fetchPrFiles(repo, pr) {
  const json = execFileSync("gh", ["pr", "view", String(pr), "--repo", repo, "--json", "files"], { encoding: "utf8" });
  const files = JSON.parse(json).files || [];
  return files.map((f) => {
    let code = "";
    try { code = execFileSync("gh", ["api", `repos/${repo}/contents/${f.path}?ref=pull/${pr}/head`, "--jq", ".content"], { encoding: "utf8" }); }
    catch { code = ""; }
    return { file: f.path, code: Buffer.from(code, "base64").toString("utf8") };
  });
}

export function run() {
  const { cases } = JSON.parse(fs.readFileSync(path.join(HERE, "..", "fixtures", "prs.json"), "utf8"));
  if (!cases.length) {
    return { name: "e2e-prs", skipped: "no PRs in fixtures/prs.json", score: null,
      report: scorecard("End-to-end on real PRs", [{ name: "status", value: "skipped (empty manifest)" }]) };
  }
  if (!ghAvailable()) {
    return { name: "e2e-prs", skipped: "gh not available", score: null,
      report: scorecard("End-to-end on real PRs", [{ name: "status", value: "skipped (gh unavailable)" }]) };
  }
  const reviewer = getReviewer();
  const matched = (e, p) => e.category === p.category && (e.file ? e.file.endsWith(p.file) || p.file.endsWith(e.file) : true);
  let expected = [], predicted = [];
  for (const c of cases) {
    expected.push(...c.expected);
    for (const f of fetchPrFiles(c.repo, c.pr)) predicted.push(...reviewer.review(f));
  }
  const m = prf1(expected, predicted, matched);
  const report = scorecard(`End-to-end on real PRs — reviewer: ${reviewer.name}`, [
    { name: "PRs", value: String(cases.length) },
    { name: "precision", value: pct(m.precision) },
    { name: "recall", value: pct(m.recall) },
    { name: "F1", value: pct(m.f1) },
  ]);
  return { name: "e2e-prs", metrics: m, score: m.f1, report };
}
