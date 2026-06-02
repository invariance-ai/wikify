// End-to-end tests that drive the real CLI binary against throwaway temp dirs,
// so exit codes and output are exercised exactly as a user would see them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "wikify.js");

// Run the CLI; returns { status, stdout, stderr } without throwing on non-zero.
function cli(args) {
  try {
    const stdout = execFileSync("node", [BIN, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "" };
  }
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wikify-it-"));
}

const PAGES = ["index.md", "wiki.md", "tests.md", "architecture.md", "decisions.md", "todos.md", "gotchas.md", "prs-and-tickets.md", "agent-protocol.md"];

test("init scaffolds all pages, links [[wiki]], and builds the mirror", () => {
  const dir = tmp();
  const { status, stdout } = cli(["init", "--root", dir, "--no-pr-history"]);
  assert.equal(status, 0);
  assert.match(stdout, /9 created, 0 already present/);
  for (const p of PAGES) assert.ok(fs.existsSync(path.join(dir, ".wiki", p)), `${p} missing`);
  assert.match(fs.readFileSync(path.join(dir, ".wiki", "index.md"), "utf8"), /\[\[wiki\]\]/);
  assert.ok(fs.existsSync(path.join(dir, ".wiki", "_site", "index.html")), "_site not built");
});

test("init is idempotent: a second run creates nothing", () => {
  const dir = tmp();
  cli(["init", "--root", dir, "--no-pr-history"]);
  const { stdout } = cli(["init", "--root", dir, "--no-pr-history"]);
  assert.match(stdout, /0 created, 9 already present/);
});

test("health passes on a freshly initialised wiki", () => {
  const dir = tmp();
  cli(["init", "--root", dir, "--no-pr-history"]);
  const { status } = cli(["health", "--root", dir]);
  assert.equal(status, 0);
});

test("build in a dir with no wiki exits 1 with the guidance message", () => {
  const dir = tmp();
  const { status, stderr } = cli(["build", "--root", dir]);
  assert.equal(status, 1);
  assert.match(stderr, /Run `wikify init`/);
});

test("audit is clean on a fresh wiki and flags a planted secret", () => {
  const dir = tmp();
  cli(["init", "--root", dir, "--no-pr-history"]);
  assert.equal(cli(["audit", "--root", dir]).status, 0);
  fs.appendFileSync(path.join(dir, ".wiki", "gotchas.md"), "\nAKIAIOSFODNN7EXAMPLE\n");
  const { status, stdout } = cli(["audit", "--root", dir]);
  assert.equal(status, 1);
  assert.match(stdout, /AWS access key/);
});
