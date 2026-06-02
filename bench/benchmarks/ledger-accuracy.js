// Benchmark 2 — ledger accuracy. Fully deterministic (no reviewer/LLM). Drives
// a sequence of stubbed test runs through `wikify test` and checks that the
// committed numbers always reflect the real run, and that `--check` catches
// drift. Score = fraction of steps where the ledger matched ground truth.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pct, scorecard } from "../lib/score.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = path.join(ROOT, "bin", "wikify.js");

function cli(args, cwd) {
  try {
    execFileSync("node", [BIN, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return 0;
  } catch (err) { return err.status ?? 1; }
}

function stubConfig(dir, tests, pass, fail) {
  fs.writeFileSync(
    path.join(dir, "wikify.config.json"),
    JSON.stringify({ testCommand: ["node", "-e", `console.log('# tests ${tests}');console.log('# pass ${pass}');console.log('# fail ${fail}')`] })
  );
}

function ledgerNum(dir, label) {
  const md = fs.readFileSync(path.join(dir, ".wiki", "tests.md"), "utf8");
  const m = md.match(new RegExp(`\\|\\s*${label}\\s*\\|\\s*(\\d+)\\s*\\|`));
  return m ? Number(m[1]) : null;
}

export function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wikify-bench-ledger-"));
  cli(["init", "--root", dir, "--no-pr-history"], dir);

  // A sequence of "PRs", each changing the test outcome.
  const steps = [
    { tests: 10, pass: 10, fail: 0 },
    { tests: 14, pass: 14, fail: 0 },
    { tests: 15, pass: 13, fail: 2 },
    { tests: 18, pass: 18, fail: 0 },
  ];
  let correct = 0;
  for (const s of steps) {
    stubConfig(dir, s.tests, s.pass, s.fail);
    cli(["test", "--root", dir, "--skip-build", "--run-label", `pr-${s.tests}`], dir);
    const numbersOk = ledgerNum(dir, "Total tests") === s.tests && ledgerNum(dir, "Passing") === s.pass && ledgerNum(dir, "Failing") === s.fail;
    // --check exits 0 when numbers match AND tests pass; exits 1 if tests fail
    // (a correct CI gate). So the expected exit reflects the test outcome.
    const expectCheck = s.fail > 0 ? 1 : 0;
    const checkOk = cli(["test", "--root", dir, "--check"], dir) === expectCheck;
    if (numbersOk && checkOk) correct += 1;
  }

  // Drift detection: corrupt the committed numbers and confirm --check fails.
  stubConfig(dir, 99, 99, 0);
  const driftCaught = cli(["test", "--root", dir, "--check"], dir) === 1;

  fs.rmSync(dir, { recursive: true, force: true });
  const accuracy = correct / steps.length;
  const score = accuracy * (driftCaught ? 1 : 0.5);
  const report = scorecard("Ledger accuracy", [
    { name: "PR steps", value: String(steps.length) },
    { name: "steps ledger was correct", value: `${correct}/${steps.length}` },
    { name: "step accuracy", value: pct(accuracy) },
    { name: "drift detected by --check", value: driftCaught ? "yes" : "NO" },
    { name: "score", value: pct(score) },
  ]);
  return { name: "ledger-accuracy", metrics: { accuracy, driftCaught }, score, report };
}
