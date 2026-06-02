// Unit tests for the pure helpers in wikify. Runs against the compiled dist/
// module (build before testing). No side effects on import — main() is only
// invoked by the bin shim.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseArgs,
  wikiPage,
  parseFrontmatter,
  slugify,
  slugForFile,
  escapeHtml,
  renderMarkdown,
  upsertManagedBlock,
  markerInsideFence,
  missingWikiMessage,
  AUDIT_PATTERNS,
} from "../dist/wikify.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tmpFile(name = "f.md") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wikify-test-"));
  return path.join(dir, name);
}

test("parseArgs: positionals, key/value, and flags", () => {
  const a = parseArgs(["init", "--root", "/tmp/x", "--no-pr-history", "github"]);
  assert.deepEqual(a._, ["init", "github"]);
  assert.equal(a.root, "/tmp/x");
  assert.equal(a["no-pr-history"], true);
});

test("parseArgs: unknown --key consumes the next token as its value", () => {
  const a = parseArgs(["--port", "5000"]);
  assert.equal(a.port, "5000");
});

test("wikiPage: emits frontmatter, heading, and trimmed body", () => {
  const page = wikiPage("Title", "Desc", "  body text  ", { section: "Project", order: 2 });
  assert.match(page, /^---\ntitle: Title\ndescription: Desc\nsection: Project\norder: 2\n---\n/);
  assert.match(page, /\n# Title\n\nbody text\n$/);
});

test("parseFrontmatter: round-trips key/value metadata (returns [meta, body])", () => {
  const [meta, body] = parseFrontmatter(wikiPage("T", "D", "hello", { order: 3 }));
  assert.equal(meta.title, "T");
  assert.equal(meta.description, "D");
  assert.equal(meta.order, "3");
  assert.match(body, /hello/);
});

test("slugify and slugForFile", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
  assert.equal(slugForFile("agent-protocol.md"), "agent-protocol");
});

test("escapeHtml escapes &, <, >, and \" (single quotes left as-is by design)", () => {
  assert.equal(escapeHtml(`<a href="x">&'`), `&lt;a href=&quot;x&quot;&gt;&amp;'`);
});

test("renderMarkdown: headings, code fences, and existing vs new wikilinks", () => {
  const ctx = { pagesBySlug: new Map([["architecture", {}]]) };
  const toc = [];
  const html = renderMarkdown(
    "## Heading\n\n```\ncode & <stuff>\n```\n\nSee [[architecture]] and [[missing]].",
    ctx,
    toc
  );
  assert.match(html, /<h2 id="heading">/);
  assert.match(html, /<pre><code>code &amp; &lt;stuff&gt;<\/code><\/pre>/);
  assert.match(html, /<a href="architecture\.html">architecture<\/a>/);
  assert.match(html, /class="new"[^>]*>missing<\/a>/);
  assert.equal(toc.length, 1);
});

test("upsertManagedBlock: create, then idempotent update preserves surrounding text", () => {
  const file = tmpFile(".gitignore");
  fs.writeFileSync(file, "node_modules/\n");
  const start = "# wikify:start";
  const end = "# wikify:end";
  assert.equal(upsertManagedBlock(file, start, end, "a.txt"), "appended");
  const after1 = fs.readFileSync(file, "utf8");
  assert.match(after1, /node_modules\//);
  assert.match(after1, /# wikify:start\na\.txt\n# wikify:end/);
  // second call with different content updates in place, not append
  assert.equal(upsertManagedBlock(file, start, end, "b.txt"), "updated");
  const after2 = fs.readFileSync(file, "utf8");
  assert.match(after2, /b\.txt/);
  assert.doesNotMatch(after2, /a\.txt/);
  // only one managed block exists
  assert.equal((after2.match(/# wikify:start/g) || []).length, 1);
});

test("markerInsideFence: true only when marker sits inside an open code fence", () => {
  assert.equal(markerInsideFence("text\n# m\nmore", "# m"), false);
  assert.equal(markerInsideFence("```\n# m\n```", "# m"), true);
});

test("missingWikiMessage: references the path and the init command", () => {
  const msg = missingWikiMessage("/repo");
  assert.match(msg, /\/repo\/\.wiki/);
  assert.match(msg, /wikify init/);
});

test("AUDIT_PATTERNS: detect secrets, miss benign text", () => {
  const hit = (s) => AUDIT_PATTERNS.some((p) => p.re.test(s));
  assert.equal(hit("AKIAIOSFODNN7EXAMPLE"), true);
  assert.equal(hit("ghp_abcdefghijklmnopqrstuvwx0123456789"), true);
  assert.equal(hit("api_key: 'sk-live-0123456789abcdef'"), true);
  assert.equal(hit("-----BEGIN RSA PRIVATE KEY-----"), true);
  assert.equal(hit("This is an ordinary sentence about architecture."), false);
});
