// Tests for the test-ledger feature: TAP parsing, file counting, and the
// `wikify test` command writing the stats block. The CLI run uses an isolated
// fixture repo with a stubbed testCommand so it never re-runs this suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTap, countTestFiles, extractLedgerStats } from "../dist/wikify.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "wikify.js");

function cli(args) {
  try {
    const stdout = execFileSync("node", [BIN, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "" };
  }
}

test("parseTap: reads the summary counters", () => {
  const tap = "TAP version 13\nok 1 - a\n# tests 12\n# pass 10\n# fail 2\n# skipped 1\n# todo 0\n";
  assert.deepEqual(parseTap(tap), { tests: 12, pass: 10, fail: 2, skipped: 1, todo: 0 });
});

test("parseTap: missing counters default to zero", () => {
  assert.deepEqual(parseTap("nothing here"), { tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0 });
});

test("countTestFiles: counts *.test.* / *.spec.* under given dirs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wikify-count-"));
  fs.mkdirSync(path.join(dir, "test"));
  fs.writeFileSync(path.join(dir, "test", "a.test.js"), "");
  fs.writeFileSync(path.join(dir, "test", "b.spec.ts"), "");
  fs.writeFileSync(path.join(dir, "test", "helper.js"), ""); // not a test file
  assert.equal(countTestFiles(dir, ["test"]), 2);
});

test("wikify test: writes parsed numbers into the ledger stats block", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wikify-ledger-"));
  cli(["init", "--root", dir, "--no-pr-history"]);
  fs.mkdirSync(path.join(dir, "test"));
  fs.writeFileSync(path.join(dir, "test", "x.test.js"), "");
  // Stubbed testCommand emits known TAP so this never re-runs the real suite.
  fs.writeFileSync(
    path.join(dir, "wikify.config.json"),
    JSON.stringify({ testCommand: ["node", "-e", "console.log('# tests 7');console.log('# pass 6');console.log('# fail 1')"] })
  );
  const { status, stdout } = cli(["test", "--root", dir, "--skip-build", "--run-label", "ci"]);
  assert.equal(status, 1, "fail>0 should set a non-zero exit");
  assert.match(stdout, /6\/7 passing, 1 failing, 1 file/);
  const ledger = fs.readFileSync(path.join(dir, ".wiki", "tests.md"), "utf8");
  assert.match(ledger, /Last run: ci — \*\*❌ failing\*\*/);
  assert.match(ledger, /\| Total tests \| 7 \|/);
  assert.match(ledger, /\| Passing \| 6 \|/);
  assert.match(ledger, /\| Failing \| 1 \|/);
});

test("extractLedgerStats: reads the numbers back out of a Stats table", () => {
  const md = "| Total tests | 9 |\n| Passing | 8 |\n| Failing | 1 |\n| Skipped | 0 |\n| Todo | 0 |\n| Test files | 4 |";
  assert.deepEqual(extractLedgerStats(md), { tests: 9, pass: 8, fail: 1, skipped: 0, todo: 0, files: 4 });
  assert.equal(extractLedgerStats("no table here"), null);
});

test("wikify test --check: passes when current, fails on drift without writing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wikify-check-"));
  cli(["init", "--root", dir, "--no-pr-history"]);
  const stub = (t, p, f) => JSON.stringify({ testCommand: ["node", "-e", `console.log('# tests ${t}');console.log('# pass ${p}');console.log('# fail ${f}')`] });
  const cfg = path.join(dir, "wikify.config.json");
  // Record a baseline of 4/4.
  fs.writeFileSync(cfg, stub(4, 4, 0));
  cli(["test", "--root", dir, "--skip-build", "--run-label", "base"]);
  // --check against the same numbers passes.
  assert.equal(cli(["test", "--root", dir, "--check"]).status, 0);
  const before = fs.readFileSync(path.join(dir, ".wiki", "tests.md"), "utf8");
  // Now the suite reports different numbers: --check must fail and NOT rewrite the file.
  fs.writeFileSync(cfg, stub(5, 5, 0));
  const drift = cli(["test", "--root", dir, "--check"]);
  assert.equal(drift.status, 1);
  assert.match(drift.stdout + drift.stderr, /stale|tests: ledger=4 actual=5/);
  assert.equal(fs.readFileSync(path.join(dir, ".wiki", "tests.md"), "utf8"), before, "--check must not modify the ledger");
});
