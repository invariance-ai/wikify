import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------
function usage() {
  console.log(`Wikify — give your repo a memory.

Agent quick start:
  If .wiki/index.md does not exist, run:
    npx @invariance/wikify init --no-pr-history

  That setup command creates the wiki Markdown pages under .wiki/, renders the
  HTML mirror under .wiki/_site/, and installs any requested agent instructions.

Usage:
  wikify init [--agent claude|codex|cursor|opencode] [--agents a,b,c] [--no-agents]
              [--with-pr-history|--no-pr-history] [--root DIR]
  wikify build [--root DIR] [--skip-provenance]
  wikify serve [--root DIR] [--port 4173]
  wikify health [--root DIR]
  wikify test [--root DIR] [--run-label LABEL] [--skip-build] [--check]
  wikify audit [--root DIR]
  wikify share [--root DIR] [--base-url URL]
  wikify connect github [--root DIR] [--pr-limit 500]
  wikify update [--pr-history] [--root DIR] [--pr-limit 500]

Commands:
  init              Create missing .wiki/*.md pages, render .wiki/_site/, and install agent wiring.
  build             Regenerate .wiki/_site/ from existing .wiki/*.md pages.
  serve             Serve the generated wiki locally at http://127.0.0.1:4173/.
  health            Check wiki presence, links, TODOs, gotchas, decisions, and orphan pages.
  test              Run the suite (config.testCommand) and write the numbers into .wiki/tests.md.
                    --check compares committed numbers to a fresh run and fails on drift (CI gate).
  audit             Scan .wiki/*.md for likely secrets before committing.
  share             Build static share assets: score badge, share page, metadata, and .nojekyll.
  connect github    Import merged GitHub PRs into a changelog section in .wiki/prs-and-tickets.md.
  update            Rebuild the HTML mirror and run health; --pr-history imports PR changelog first.

Examples:
  npx @invariance/wikify init --agent claude --no-pr-history
  npx @invariance/wikify init --agents claude,codex,cursor,opencode --with-pr-history
  npx @invariance/wikify connect github --pr-limit 500
  npx @invariance/wikify build
  npx @invariance/wikify share --base-url https://example.com/wiki
  npx @invariance/wikify serve
  npx @invariance/wikify health
`);
}

function missingWikiMessage(root) {
  return [
    `No .wiki/ found at ${path.join(root, ".wiki")}.`,
    "Run `wikify init` to create the wiki pages first.",
    "Agent-safe setup example: `npx @invariance/wikify init --no-pr-history`.",
  ].join("\n");
}

function parseArgs(argv) {
  const args: any = { _: [] };
  const flags = new Set(["with-pr-history", "no-pr-history", "pr-history", "no-agents", "skip-provenance", "skip-build", "check", "dry-run", "orphans", "stale"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (flags.has(key)) {
      args[key] = true;
      continue;
    }
    args[key] = argv[i + 1];
    i += 1;
  }
  return args;
}

// ---------------------------------------------------------------------------
// fs helpers + managed blocks
// ---------------------------------------------------------------------------
function mkdirp(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeIfMissing(filePath, content) {
  mkdirp(filePath);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content);
    return true;
  }
  return false;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Idempotently write a managed block delimited by start/end markers, preserving
// everything outside the markers. Refuses to touch markers that appear inside a
// fenced code block (so it can't corrupt CLAUDE.md/AGENTS.md docs).
function upsertManagedBlock(filePath, start, end, content) {
  mkdirp(filePath);
  const block = `${start}\n${content.trim()}\n${end}\n`;
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, block);
    return "created";
  }
  const existing = fs.readFileSync(filePath, "utf8");
  if (markerInsideFence(existing, start)) {
    console.warn(`  ! ${path.basename(filePath)}: marker ${start} appears inside a code fence; leaving file untouched.`);
    return "skipped";
  }
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`);
  if (pattern.test(existing)) {
    fs.writeFileSync(filePath, existing.replace(pattern, block));
    return "updated";
  }
  fs.writeFileSync(filePath, `${existing.trimEnd()}\n\n${block}`);
  return "appended";
}

function markerInsideFence(text, marker) {
  const idx = text.indexOf(marker);
  if (idx === -1) return false;
  const before = text.slice(0, idx);
  const fences = (before.match(/^```/gm) || []).length;
  return fences % 2 === 1; // odd number of fences before marker => inside a fence
}

// ---------------------------------------------------------------------------
// init / scaffold
// ---------------------------------------------------------------------------
function wikiPage(title, description, body, extraMeta = {}) {
  const metaLines = [`title: ${title}`, `description: ${description}`];
  for (const [k, v] of Object.entries(extraMeta)) metaLines.push(`${k}: ${v}`);
  return `---\n${metaLines.join("\n")}\n---\n\n# ${title}\n\n${body.trim()}\n`;
}

function repoName(root) {
  return path.basename(root) || "Repository";
}

const GITIGNORE_START = "# wikify:start (managed - edits inside this block are overwritten)";
const GITIGNORE_END = "# wikify:end";
const GITIGNORE_BODY = `# Generated wiki mirror (regenerated by \`wikify build\`; do not commit)
.wiki/_site/
.wiki/.build-cache.json
.wiki/.imported-prs.json
.wiki/_imported/

# Wikify package runtime artifacts
node_modules/
dist/

# Secrets — never commit (keys, tokens, backend URLs, local env)
.env
.env.local
.env.*.local
**/.temp/`;

// Writes/updates a managed .gitignore block in the target repo. Commits the
// .md source-of-truth; ignores generated output and secrets.
function upsertGitignore(root) {
  const result = upsertManagedBlock(path.join(root, ".gitignore"), GITIGNORE_START, GITIGNORE_END, GITIGNORE_BODY);
  console.log(`  .gitignore managed block ${result} (ignores _site/, node_modules/, .env*; commits .wiki/*.md)`);
}

// The test ledger's stats table lives between these markers and is written
// mechanically by `wikify test`. CI fails if a commit's numbers drift from a
// real run (see .github/workflows/ci.yml), so the numbers can't go stale.
const TEST_STATS_START = "<!-- wikify:test-stats:start (managed by `wikify test` — do not edit) -->";
const TEST_STATS_END = "<!-- wikify:test-stats:end -->";

function testLedgerBody() {
  return `This page is the authoritative record of this repository's automated tests. The **Stats** block is written mechanically by \`wikify test\`; do not hand-edit it — CI fails if the committed numbers drift from a real run.\n\n## Coverage map\n\nDescribe what the suite covers, area by area. Hand-maintained; keep it honest.\n\n- _Add an entry per test area: what it exercises and what it deliberately does not._\n\n## Discipline\n\nEvery PR must keep these numbers current: run \`wikify test\` and commit the updated [[tests]] page. The review skill records tests added / touched per PR alongside the [[prs-and-tickets]] context.\n\n## Stats\n\n${TEST_STATS_START}\n_No run recorded yet. Run \`wikify test\`._\n${TEST_STATS_END}`;
}

function initWiki(root, opts) {
  const wiki = path.join(root, ".wiki");
  const withPrHistory = Boolean(opts["with-pr-history"]);
  const noPrHistory = Boolean(opts["no-pr-history"]);
  const prMode = withPrHistory ? "with PR history" : "without PR history";
  const ensuredPages = [];

  const ensurePage = (file, title, description, body, extraMeta = {}) => {
    const created = writeIfMissing(path.join(wiki, file), wikiPage(title, description, body, extraMeta));
    ensuredPages.push({ file, created });
  };

  fs.mkdirSync(wiki, { recursive: true });
  ensurePage(
    "index.md",
    `${repoName(root)} Wiki`,
    "A living in-repo wiki for humans and coding agents.",
    `This wiki is the durable memory for this repository. The Markdown files under \`.wiki/\` are the source of truth for agents. The HTML files under \`.wiki/_site/\` are the human-readable mirror.\n\n## Start here\n\n- [[wiki]] — preferences for creating and adding to this wiki\n- [[architecture]]\n- [[decisions]]\n- [[todos]]\n- [[gotchas]]\n- [[prs-and-tickets]]\n- [[agent-protocol]]\n\nInitialized ${prMode}.\n\n## Mirror rule\n\nWhen a wiki Markdown page changes, run \`wikify build\` to regenerate \`.wiki/_site/\`.`,
    { section: "Navigation", order: 1, nav_label: "Main page" }
  );
  ensurePage(
    "wiki.md",
    "Wiki preferences", "Preferences that govern how this wiki is created and extended.",
    `Preferences here govern how agents **create** and **add to** this wiki. Read this page before writing any wiki content, and keep it up to date as preferences change.\n\n## Audience\n\nState who reads this wiki so prose is pitched correctly.\n\n- Default audience: mixed (engineers and non-engineers).\n- If the primary reader is a **non-developer**, include short **code excerpts with plain-English explanations** rather than bare \`file:line\` references — lead with the what/why, then the how, and define jargon on first use.\n\n## On wiki creation\n\n- Keep [[index]] as the single entry point; every page links back to it.\n- One concept per page; link liberally with \`[[wikilinks]]\`.\n- Markdown under \`.wiki/\` is the source of truth; run \`wikify build\` to refresh the HTML mirror.\n\n## On wiki adding\n\n- Add durable knowledge only: decisions, gotchas, architecture, persistent TODOs, PR/ticket context, user corrections.\n- Do not store secrets or transient progress.\n- Match the **Audience** preference above when writing prose and examples.\n- After edits, run \`wikify build\` and \`wikify health\`.`,
    { section: "Wikify", order: 1 }
  );
  ensurePage(
    "tests.md",
    "Test ledger", "Authoritative record of automated tests and their numbers.",
    testLedgerBody(),
    { section: "Wikify", order: 3 }
  );
  ensurePage(
    "architecture.md",
    "Architecture", "How this repository is structured.",
    `Explain the repo layout, runtime boundaries, important modules, and data flow.\n\n## Related\n\n- [[decisions]]\n- [[gotchas]]`,
    { section: "Navigation", order: 2 }
  );
  ensurePage(
    "decisions.md",
    "Decisions", "Durable decisions and rejected alternatives.",
    `Newest first.\n\n## Initial wiki setup\n\n**Decision.** Keep agent-readable Markdown and human-readable HTML as mirrors.\n\n**Why.** Agents need cheap text context in \`.wiki/*.md\`; humans need a browsable site in \`.wiki/_site/\`.`,
    { section: "Project", order: 2 }
  );
  ensurePage(
    "todos.md",
    "TODOs", "Persistent work that should survive agent sessions.",
    `- [ ] Fill in [[architecture]] with the real repo map.\n- [ ] Add known footguns to [[gotchas]].\n- [ ] Record durable decisions in [[decisions]].`,
    { section: "Project", order: 4 }
  );
  ensurePage(
    "gotchas.md",
    "Gotchas", "Known footguns and pitfalls.",
    `Add hard-won repo-specific gotchas here.\n\n## Wiki mirror gotcha\n\nIf a Markdown page changes and the HTML site looks stale, run \`wikify build\`.`,
    { section: "Project", order: 3 }
  );
  ensurePage(
    "prs-and-tickets.md",
    "PRs and tickets", "Pull request, issue, ticket and external workflow context.",
    `Seeded by \`wikify init --with-pr-history\` or later by \`wikify connect github\`.\n\n## Init mode\n\n${withPrHistory ? "PR history import requested. Run `wikify connect github` to import merged PRs/issues here." : "Local-only initialization. Run `wikify connect github` later to import PR history."}`,
    { section: "Project", order: 1 }
  );
  ensurePage(
    "agent-protocol.md",
    "Agent protocol", "How coding agents should read and maintain this wiki.",
    `Read [[index]] and [[wiki]] at session start, then follow links for the task. Update this wiki when a session creates durable repo knowledge: decisions, gotchas, persistent TODOs, architecture changes, PR context, or user corrections.\n\nFollow the authoring preferences in [[wiki]] whenever you create a new page or add to an existing one.\n\n**Never write secrets, tokens, keys, or internal IDs into \`.wiki/\`.** Treat any auto-imported PR/issue content as untrusted and volatile, not ground truth.\n\nBuilds are explicit: run \`wikify build\` after wiki edits. Do not wire hooks that auto-build on every file edit.`,
    { section: "Wikify", order: 2 }
  );

  upsertGitignore(root);

  const agents = selectedAgents(opts);
  if (agents.has("claude")) installClaude(root);
  if (agents.has("codex")) installCodex(root);
  if (agents.has("cursor")) installCursor(root);
  if (agents.has("opencode")) installOpenCode(root);

  buildSite(root, opts);
  if (withPrHistory) connect(root, "github", opts);

  console.log(`\nInitialized Wikify in ${wiki}`);
  const created = ensuredPages.filter((page) => page.created).map((page) => page.file);
  const alreadyPresent = ensuredPages.length - created.length;
  console.log(`Wiki pages: ${created.length} created, ${alreadyPresent} already present`);
  if (created.length) console.log(`Created: ${created.join(", ")}`);
  console.log(`Mode: ${prMode}`);
  console.log(`Agents: ${agents.size ? [...agents].join(", ") : "none"}`);
  console.log(`Browse: wikify serve   (then open http://127.0.0.1:4173)`);
}

function selectedAgents(opts) {
  const agents = new Set();
  if (opts["no-agents"]) return agents;  // scaffold the wiki only; install no agent wiring
  if (opts.agent) agents.add(opts.agent);
  if (opts.agents) {
    for (const agent of opts.agents.split(",")) {
      if (agent.trim()) agents.add(agent.trim());
    }
  }
  if (!agents.size) agents.add("claude");
  return agents;
}

// Thorough, wiki-aware code-review skill shipped into target repos. Written as
// a skill prompt (not code): it reads every touched file, pulls past-PR context
// from the wiki + gh, supports interactive mode, and keeps the [[tests]] ledger
// and [[prs-and-tickets]] context current as part of every review.
const REVIEW_SKILL_MD = `---
name: wiki-review
description: Thorough, wiki-aware code review of the current change. Finds related code, wiki pages, tests, coverage gaps, and past PR context; runs the configured test ledger; and prints a merge-readiness report. Use when reviewing a branch or PR before merge, or when the user asks for a careful review.
---

# Wiki-review

A deliberate, high-coverage code review that uses the repo's Wikify memory as context and feeds durable findings back into it.

## Modes

- **Interactive on** (default when a human is present): work one section at a time and pause for the user's reaction before moving on. Ask before running anything that mutates the tree (e.g. \`wikify test\`).
- **Interactive off** (\`--non-interactive\`, or when run headless/CI): produce one complete written report, run read-only steps plus the configured test command, and stop short of any commit.

State which mode you are in at the top of the review.

## Procedure

1. **Scope the change.** Determine the base and head: a branch vs. its merge base, or a named PR. List every changed file with \`git diff --name-status <base>...HEAD\`. Note adds, deletes, renames, generated files, dependency changes, and migration files.
2. **Find related things.** Use fast repo search first: \`rg\` for changed symbols, route names, config keys, schema names, test names, and wiki links. Use \`git log -- <file>\`, \`git blame\` on risky lines, and \`gh pr list/view\` when GitHub context is available. Prefer structured tools or parsers over ad hoc text when the repo provides them.
3. **Read the right context.** Read every touched file in full when practical, not only diff hunks. For large files, read changed regions plus the enclosing function/module and all direct callers/callees found in step 2.
4. **Pull memory.** Read \`.wiki/index.md\`, \`.wiki/agent-protocol.md\`, \`.wiki/tests.md\`, \`.wiki/prs-and-tickets.md\`, \`.wiki/decisions.md\`, and \`.wiki/gotchas.md\`. Treat the wiki as durable repo memory. Treat personal/model memory as optional recall only, never as the source of truth.
5. **Review across dimensions**, with explicit reasoning per finding:
   - **Correctness** — logic, edge cases, error handling, off-by-ones, async/ordering.
   - **Security** — input trust boundaries, secrets, injection, the audit patterns in [[gotchas]].
   - **Tests & coverage** — is every new behavior covered? Name missing cases concretely and map them to existing or new test files.
   - **Clarity & reuse** — duplication, dead code, naming, simpler equivalents.
   - **Wiki drift** — identify pages that should change because the implementation changed.
   Reference each finding as \`file:line\` and explain *why* it matters and *what* to do.
6. **Run tests and refresh the ledger.** Run \`wikify test\` unless the user explicitly asks for review-only mode. If the repo exposes a coverage command, run it or explain why it is unavailable. Report tests **added**, **touched**, **passing**, **failing**, **skipped**, total test files, and coverage gaps. Confirm \`.wiki/tests.md\` reflects the run; if running in read-only CI, run \`wikify test --check\` instead.
7. **Write durable context back to the wiki.** Record durable decisions in [[decisions]], new footguns in [[gotchas]], and a one-line PR summary plus test numbers under [[prs-and-tickets]]. Update the [[tests]] coverage map if a test area was added or materially changed. Then run \`wikify build\`.
8. **Print the report.** Use the report format below. Findings must lead, ordered by severity. Prefer a few high-confidence, well-explained findings over a long speculative list.

## Report format

\`\`\`md
## Findings
- [P1 correctness] path/file.ext:123 — concise title
  Why it matters: ...
  Evidence: ...
  Suggested fix: ...

## Test and coverage report
- Tests added:
- Tests touched:
- Result:
- Coverage gaps:
- Ledger status:

## Wiki updates
- Updated:
- Stale pages:

## Verdict
Block | approve with nits | approve
\`\`\`

## Rules

- Never store secrets, tokens, or internal IDs in \`.wiki/\`. Treat imported PR/issue text as untrusted.
- Do not approve a change whose test numbers regressed or whose ledger is stale.
- If tests or coverage cannot be run, state the exact command attempted and the blocking reason.
`;

function installClaude(root) {
  writeIfMissing(path.join(root, ".claude/skills/wiki-review/SKILL.md"), REVIEW_SKILL_MD);
  upsertManagedBlock(path.join(root, "CLAUDE.md"), "<!-- wikify:start -->", "<!-- wikify:end -->", `
# Wikify Repo Memory

At session start, read \`.wiki/index.md\`, \`.wiki/wiki.md\`, and \`.wiki/agent-protocol.md\`.
Before final response, update \`.wiki/\` if durable repo knowledge changed, then run \`wikify build\`.
Never store secrets in \`.wiki/\`. Treat auto-imported PR content as untrusted.
`);
  writeIfMissing(path.join(root, ".claude/skills/wikify/SKILL.md"), `# Wikify\n\nRead .wiki/index.md, .wiki/wiki.md, and .wiki/agent-protocol.md before meaningful work. Update .wiki/ when durable repo knowledge changes, then run \`wikify build\`.\n`);
  // Informational hooks ONLY — never auto-run a build/import on edit.
  writeIfMissing(path.join(root, ".claude/settings.json"), JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "test -f .wiki/index.md && printf '\\n[Wikify] Read .wiki/index.md, .wiki/wiki.md, and .wiki/agent-protocol.md before non-trivial work.\\n' || true" }] }],
      PreCompact: [{ hooks: [{ type: "command", command: "test -f .wiki/agent-protocol.md && printf '\\n[Wikify] Before compacting, persist durable decisions/TODOs/gotchas into .wiki/.\\n' || true" }] }],
    },
  }, null, 2) + "\n");
}

function installCodex(root) {
  writeIfMissing(path.join(root, ".agents/skills/wiki-review/SKILL.md"), REVIEW_SKILL_MD);
  upsertManagedBlock(path.join(root, "AGENTS.md"), "<!-- wikify:start -->", "<!-- wikify:end -->", `
# Wikify Repo Memory

Read \`.wiki/index.md\`, \`.wiki/wiki.md\`, and \`.wiki/agent-protocol.md\` at session start. Update \`.wiki/\` when durable repo knowledge changes, then run \`wikify build\`. Never store secrets in \`.wiki/\`.

## Review guidelines

For branch or pull request review, use the \`wiki-review\` skill. It must inspect related code, wiki memory, tests, coverage gaps, and PR history before giving a merge verdict.
`);
  upsertManagedBlock(path.join(root, ".codex/config.toml"), "# wikify:start", "# wikify:end", `notify = ["bash", "-lc", "test -f .wiki/index.md && echo '[Wikify] Review .wiki before closeout.' || true"]`);
}

function installCursor(root) {
  writeIfMissing(path.join(root, ".cursor/rules/wikify.mdc"), `---\ndescription: Wikify repo memory. Read and maintain .wiki/.\nalwaysApply: true\n---\n\nRead .wiki/index.md, .wiki/wiki.md, and .wiki/agent-protocol.md at session start. Update .wiki/ when durable repo knowledge changes, then run \`wikify build\`. Never store secrets in .wiki/.\n`);
}

function installOpenCode(root) {
  upsertManagedBlock(path.join(root, "AGENTS.md"), "<!-- wikify:start -->", "<!-- wikify:end -->", `
# Wikify Repo Memory

Read \`.wiki/index.md\`, \`.wiki/wiki.md\`, and \`.wiki/agent-protocol.md\` at session start. Update \`.wiki/\` before closeout when durable repo knowledge changes, then run \`wikify build\`.
`);
}

// ---------------------------------------------------------------------------
// config + git remote auto-detection
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG: any = {
  title: null,            // sidebar wordmark; defaults to "<repo> Wiki"
  tagline: "Generated by Wikify",
  sectionOrder: ["Navigation", "Surfaces", "Project", "Wikify", "About"],
  ticketPage: "prs-and-tickets",
  testCommand: ["node", "--test", "--test-reporter=tap"],  // run by `wikify test`; must emit TAP
  testGlobs: ["test", "tests", "src"],                     // dirs scanned to count *.test.* / *.spec.* files
  ticketDenylist: ["HTTP", "HTTPS", "HTTP2", "S3", "EC2", "AWS", "GCP", "OAUTH", "OAUTH2", "API", "REST", "SQL", "JSON", "JWT", "CORS", "OTLP", "HTML", "CSS", "UTF", "UTF8", "SHA", "SHA256", "RFC", "ISO", "UTC", "URL", "URI", "SSO", "RBAC", "MVP", "CLI", "MCP", "SDK", "CRUD", "TS", "JS", "CI", "CD"],
  githubRepos: null,      // {name: https url}; auto-detected if null
};

function loadConfig(root) {
  const cfg = { ...DEFAULT_CONFIG };
  const p = path.join(root, "wikify.config.json");
  if (fs.existsSync(p)) {
    try {
      Object.assign(cfg, JSON.parse(fs.readFileSync(p, "utf8")));
    } catch (err) {
      console.warn(`  ! wikify.config.json is not valid JSON; using defaults (${err.message})`);
    }
  }
  if (!cfg.githubRepos) cfg.githubRepos = detectGitHubRepos(root);
  if (!cfg.title) cfg.title = `${repoName(root)} Wiki`;
  return cfg;
}

function gitRemote(dir) {
  try {
    return (execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) as string).trim();
  } catch {
    return null;
  }
}

function parseRemoteToHttps(url) {
  if (!url) return null;
  let m = url.match(/git@github\.com:(.+?)(?:\.git)?$/);
  if (m) return `https://github.com/${m[1]}`;
  m = url.match(/https?:\/\/github\.com\/(.+?)(?:\.git)?$/);
  if (m) return `https://github.com/${m[1]}`;
  return null;
}

function parseGitHubOwnerRepo(url) {
  const https = parseRemoteToHttps(url);
  if (!https) return null;
  const m = https.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
}

// Map repo-name -> GitHub https URL, from the root repo and each immediate
// sub-directory that is its own git repo (covers monorepos of sibling repos).
function detectGitHubRepos(root) {
  const repos = {};
  const add = (name, dir) => {
    const url = parseRemoteToHttps(gitRemote(dir));
    if (url) repos[name] = url;
  };
  add(path.basename(root), root);
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch { /* ignore */ }
  for (const e of entries) {
    if (e.isDirectory() && fs.existsSync(path.join(root, e.name, ".git"))) {
      add(e.name, path.join(root, e.name));
    }
  }
  return repos;
}

function commandOutput(cmd, args, opts: any = {}) {
  try {
    return (execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      ...opts,
    }) as string).trim();
  } catch {
    return null;
  }
}

function commandExists(cmd) {
  return commandOutput("sh", ["-c", `command -v ${cmd}`]) != null;
}

function githubAuthToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  return commandExists("gh") ? commandOutput("gh", ["auth", "token"]) : null;
}

function githubRepoForRoot(root) {
  const remote = gitRemote(root);
  if (!remote) return null;
  return parseGitHubOwnerRepo(remote);
}

function sanitizeMdText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function monthName(iso) {
  return iso.slice(0, 7);
}

function prLimit(opts) {
  const raw = Number(opts["pr-limit"] || 500);
  if (!Number.isFinite(raw) || raw <= 0) return 500;
  return Math.min(Math.floor(raw), 2000);
}

function fetchGithubPulls(owner, repo, limit) {
  const token = githubAuthToken();
  if (!commandExists("curl")) {
    console.error("GitHub PR import requires `curl`.");
    process.exitCode = 1;
    return [];
  }

  const pulls = [];
  for (let page = 1; pulls.length < limit; page += 1) {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`;
    const args = [
      "-fsSL",
      "-H", "Accept: application/vnd.github+json",
      "-H", "X-GitHub-Api-Version: 2022-11-28",
    ];
    if (token) args.push("-H", `Authorization: Bearer ${token}`);
    args.push(url);

    let batch;
    try {
      batch = JSON.parse(execFileSync("curl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) as string);
    } catch (err) {
      console.error(`GitHub PR import failed for ${owner}/${repo}: ${err.message}`);
      console.error("Use `gh auth login`, set GITHUB_TOKEN/GH_TOKEN, or verify the GitHub remote is accessible.");
      process.exitCode = 1;
      return [];
    }

    if (!Array.isArray(batch) || !batch.length) break;
    pulls.push(...batch);
    if (batch.length < 100) break;
  }
  return pulls.slice(0, limit);
}

function normalizedPr(pr) {
  return {
    number: pr.number,
    title: sanitizeMdText(pr.title),
    url: pr.html_url,
    author: pr.user?.login || "unknown",
    mergedAt: pr.merged_at,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    labels: (pr.labels || []).map((label) => label.name).filter(Boolean),
    base: pr.base?.ref || "",
    head: pr.head?.ref || "",
    mergeCommit: pr.merge_commit_sha || "",
    body: pr.body || "",
  };
}

function changelogMarkdown(owner, repo, prs, importedAt) {
  const merged = prs
    .map(normalizedPr)
    .filter((pr) => pr.mergedAt)
    .sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)));

  const lines = [
    "## GitHub PR changelog",
    "",
    `Imported from [${owner}/${repo}](https://github.com/${owner}/${repo}) on ${fmtDateTime(importedAt)}.`,
    `This changelog uses merged PR titles and metadata only. Raw imported PR JSON is stored under ignored \`.wiki/_imported/\` for review and is not the source of truth.`,
    "",
  ];

  if (!merged.length) {
    lines.push("No merged pull requests were found.");
    return lines.join("\n");
  }

  let currentMonth = "";
  for (const pr of merged) {
    const month = monthName(pr.mergedAt);
    if (month !== currentMonth) {
      currentMonth = month;
      lines.push(`### ${month}`, "");
    }
    const labels = pr.labels.length ? ` (${pr.labels.join(", ")})` : "";
    const branch = pr.base ? ` into \`${pr.base}\`` : "";
    lines.push(`- ${fmtDate(new Date(pr.mergedAt))}: [#${pr.number}](${pr.url}) ${pr.title}${labels} — merged by/for @${pr.author}${branch}.`);
  }

  return lines.join("\n");
}

function upsertMarkdownSection(filePath, heading, sectionContent) {
  mkdirp(filePath);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, wikiPage("PRs and tickets", "Pull request, issue, ticket and external workflow context.", sectionContent, { section: "Project", order: 1 }));
    return;
  }

  const existing = fs.readFileSync(filePath, "utf8");
  const headingPattern = new RegExp(`^## ${escapeRegExp(heading)}\\s*$`, "m");
  const match = headingPattern.exec(existing);
  if (!match) {
    fs.writeFileSync(filePath, `${existing.trimEnd()}\n\n${sectionContent.trim()}\n`);
    return;
  }

  const start = match.index;
  const afterHeading = start + match[0].length;
  const rest = existing.slice(afterHeading);
  const next = /\n##\s+/.exec(rest);
  const end = next ? afterHeading + next.index : existing.length;
  fs.writeFileSync(filePath, `${existing.slice(0, start).trimEnd()}\n\n${sectionContent.trim()}\n${existing.slice(end)}`);
}

// ---------------------------------------------------------------------------
// provenance (git staleness) — degrades gracefully
// ---------------------------------------------------------------------------
function gitLog1(repoPath, relpath) {
  try {
    const out = (execFileSync("git", ["-C", repoPath, "log", "-1", "--format=%h|%cI", "--", relpath], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) as string).trim();
    if (!out.includes("|")) return null;
    const [hash, iso] = out.split("|");
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    return { hash, iso, date };
  } catch {
    return null;
  }
}

function sourceFreshness(sources, root) {
  const entries = [];
  const missing = [];
  for (const source of sources) {
    const idx = source.indexOf("/");
    if (idx === -1) { missing.push(source); continue; }
    const repo = source.slice(0, idx);
    const rel = source.slice(idx + 1);
    const repoPath = path.join(root, repo);
    if (!fs.existsSync(repoPath)) { missing.push(source); continue; }
    const info = gitLog1(repoPath, rel);
    if (!info) { missing.push(source); continue; }
    entries.push({ path: source, ...info });
  }
  const latest = entries.length ? entries.reduce((a, b) => (b.date > a.date ? b : a)) : null;
  return { entries, missing, latest };
}

function pageMtime(filePath) {
  try { return fs.statSync(filePath).mtime; } catch { return new Date(0); }
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function fmtDateTime(d) {
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

// ---------------------------------------------------------------------------
// markdown parsing
// ---------------------------------------------------------------------------
function parseFrontmatter(raw) {
  if (!raw.startsWith("---\n")) return [{}, raw];
  const end = raw.indexOf("\n---", 4);
  if (end === -1) return [{}, raw];
  const meta: Record<string, string> = {};
  for (const line of raw.slice(4, end).split("\n")) {
    const idx = line.indexOf(":");
    if (idx !== -1) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return [meta, raw.slice(end + 4).replace(/^\n+/, "")];
}

function splitSources(value) {
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function slugForFile(file) {
  const normalized = file.replace(/\\/g, "/").replace(/\.md$/, "");
  // flatten concepts/x -> x, matching the dogfood
  return path.basename(normalized);
}

function htmlFileForSlug(slug) {
  return `${slug}.html`;
}

function titleFromSlug(slug) {
  return slug.split("/").pop().replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function slugify(value) {
  return value.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-").replace(/-+/g, "-");
}

function collectLinks(md, pagesBySlug) {
  const links = new Set();
  for (const m of md.matchAll(/\[\[([^\]]+)\]\]/g)) {
    let target = m[1];
    if (target.includes("|")) target = target.split("|")[0];
    if (target.includes("#")) target = target.split("#")[0];
    target = target.trim();
    if (pagesBySlug.has(target)) links.add(target);
  }
  return links;
}

function renderInline(text, ctx) {
  let out = escapeHtml(text);

  // protect inline code spans
  const codes = [];
  out = out.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return ` ${codes.length - 1} `;
  });

  // wiki links [[slug]] / [[slug|label]] / [[slug#anchor|label]]
  out = out.replace(/\[\[([^\]]+)\]\]/g, (_, body) => {
    let target = body;
    let label = null;
    if (target.includes("|")) { const parts = target.split("|"); target = parts[0]; label = parts.slice(1).join("|"); }
    let anchor = "";
    if (target.includes("#")) { const parts = target.split("#"); target = parts[0]; anchor = parts[1]; }
    target = target.trim();
    label = (label != null ? label : target).trim();
    if (ctx.pagesBySlug.has(target)) {
      const href = htmlFileForSlug(target) + (anchor ? `#${anchor.trim()}` : "");
      return `<a href="${href}">${label}</a>`;
    }
    return `<a class="new" title="page does not exist" href="#">${label}</a>`;
  });

  // markdown links [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => `<a href="${href}">${label}</a>`);

  // explicit GitHub refs: "<repo> PR #12" / "<repo> issue #12"
  out = out.replace(/\b([A-Za-z][\w.-]*?)\s+(PR|issue)\s+#(\d+)\b/gi, (whole, repo, kind, num) => {
    const url = ctx.githubRepos[repo];
    if (!url) return whole;
    const isPr = kind.toLowerCase() === "pr";
    return `<a href="${url}/${isPr ? "pull" : "issues"}/${num}">${repo} ${isPr ? "PR" : "issue"} #${num}</a>`;
  });

  // short GitHub refs: "<repo> #12" -> pull request
  out = out.replace(/\b([A-Za-z][\w.-]*?)\s+#(\d+)\b/g, (whole, repo, num) => {
    const url = ctx.githubRepos[repo];
    if (!url) return whole;
    return `<a href="${url}/pull/${num}">${repo} #${num}</a>`;
  });

  // ticket/entity refs e.g. PAY-418 -> wiki ticket page anchor (with denylist to
  // avoid false positives on HTTP-2 / S3-2 / AWS-* etc.)
  if (ctx.hasTicketPage) {
    out = out.replace(/\b([A-Z][A-Z0-9]+)-(\d+)\b/g, (whole, prefix, num) => {
      if (prefix === "ADR" || ctx.ticketDenylist.has(prefix)) return whole;
      const id = `${prefix}-${num}`;
      return `<a href="${ctx.ticketPage}.html#${id.toLowerCase()}">${id}</a>`;
    });
  }

  // bold then italic
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, "<em>$1</em>");

  // restore code spans
  out = out.replace(/ (\d+) /g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  return out;
}

function isTableSep(s) {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(s) && s.includes("-");
}

function splitTableRow(line) {
  const codes = [];
  let s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  s = s.replace(/`[^`]*`/g, (m) => { codes.push(m); return ` ${codes.length - 1} `; });
  return s.split("|").map((c) => c.replace(/ (\d+) /g, (_, i) => codes[Number(i)]).trim());
}

function buildList(items, ctx) {
  function render(idx, level) {
    const ordered = items[idx].ordered;
    const tag = ordered ? "ol" : "ul";
    const parts = [`<${tag}>`];
    let i = idx;
    while (i < items.length && items[i].level === level) {
      const text = renderInline(items[i].text, ctx);
      if (i + 1 < items.length && items[i + 1].level > level) {
        const [childHtml, next] = render(i + 1, items[i + 1].level);
        parts.push(`<li>${text}${childHtml}</li>`);
        i = next;
      } else {
        parts.push(`<li>${text}</li>`);
        i += 1;
      }
    }
    parts.push(`</${tag}>`);
    return [parts.join(""), i];
  }
  return render(0, items[0].level)[0];
}

function renderMarkdown(markdown, ctx, toc) {
  const lines = markdown.split("\n");
  const out = [];
  let i = 0;
  const n = lines.length;

  while (i < n) {
    const line = lines[i];

    // fenced code
    if (line.trim().startsWith("```")) {
      i += 1;
      const buf = [];
      while (i < n && !lines[i].trim().startsWith("```")) { buf.push(lines[i]); i += 1; }
      i += 1;
      out.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // headings
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const inner = renderInline(heading[2].trim(), ctx);
      const id = slugify(heading[2]);
      if (level === 2 || level === 3) toc.push({ level, id, text: inner.replace(/<[^>]+>/g, "") });
      const anchor = `<a class="anchor" href="#${id}" aria-hidden="true">¶</a>`;
      out.push(`<h${level} id="${id}">${inner}${anchor}</h${level}>`);
      i += 1;
      continue;
    }

    // horizontal rule
    if (/^\s*([-*])\1\1+\s*$/.test(line)) { out.push("<hr>"); i += 1; continue; }

    // table
    if (line.includes("|") && i + 1 < n && isTableSep(lines[i + 1])) {
      const header = splitTableRow(line);
      i += 2;
      const rows = [];
      while (i < n && lines[i].includes("|") && lines[i].trim()) { rows.push(splitTableRow(lines[i])); i += 1; }
      const th = header.map((c) => `<th>${renderInline(c, ctx)}</th>`).join("");
      const trs = rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c, ctx)}</td>`).join("")}</tr>`).join("");
      out.push(`<table class="wikitable"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`);
      continue;
    }

    // blockquote
    if (line.replace(/^\s+/, "").startsWith(">")) {
      const buf = [];
      while (i < n && lines[i].replace(/^\s+/, "").startsWith(">")) { buf.push(lines[i].replace(/^\s*>\s?/, "")); i += 1; }
      out.push(`<blockquote><p>${renderInline(buf.filter((b) => b.trim()).join(" "), ctx)}</p></blockquote>`);
      continue;
    }

    // lists (indentation-based nesting)
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items = [];
      while (i < n && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        const lm = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        items.push({ level: Math.floor(lm[1].length / 2), ordered: /\d+\./.test(lm[2]), text: lm[3] });
        i += 1;
      }
      out.push(buildList(items, ctx));
      continue;
    }

    // blank
    if (!line.trim()) { i += 1; continue; }

    // paragraph
    const buf = [line];
    i += 1;
    while (
      i < n && lines[i].trim() &&
      !/^(#{1,6}\s|```|\s*([-*]|\d+\.)\s|\s*>|\s*([-*])\3\3)/.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < n && isTableSep(lines[i + 1]))
    ) { buf.push(lines[i]); i += 1; }
    out.push(`<p>${renderInline(buf.join(" "), ctx)}</p>`);
  }

  return out.join("\n");
}

function renderToc(toc) {
  if (toc.length < 3) return "";
  const rows = [];
  let c1 = 0;
  let c2 = 0;
  for (const t of toc) {
    let num;
    let cls;
    if (t.level === 2) { c1 += 1; c2 = 0; num = `${c1}`; cls = "toclevel-1"; }
    else { c2 += 1; num = `${c1}.${c2}`; cls = "toclevel-2"; }
    rows.push(`<li class="${cls}"><a href="#${t.id}"><span class="tocnumber">${num}</span> <span class="toctext">${t.text}</span></a></li>`);
  }
  return `<div class="toc"><div class="toctitle">Contents</div><ul>${rows.join("")}</ul></div>`;
}

function renderBacklinks(slug, backlinks, titles) {
  const refs = [...(backlinks.get(slug) || [])].sort((a, b) => (titles.get(a) || a).toLowerCase().localeCompare((titles.get(b) || b).toLowerCase()));
  if (!refs.length) return "";
  const items = refs.map((s) => `<li><a href="${htmlFileForSlug(s)}">${escapeHtml(titles.get(s) || s)}</a></li>`).join("");
  return `<div class="backlinks"><div class="box-title">Referenced by</div><ul>${items}</ul></div>`;
}

function renderProvenance(updated, freshness) {
  const count = freshness.entries.length;
  const pieces = [`Last updated ${fmtDateTime(updated)}`];
  if (count) {
    const d = fmtDate(freshness.latest.date);
    pieces.push(`derived from ${count} source${count !== 1 ? "s" : ""} (latest commit <code>${escapeHtml(freshness.latest.hash)}</code>, ${d})`);
  }
  if (freshness.missing.length) pieces.push(`${freshness.missing.length} source path${freshness.missing.length !== 1 ? "s" : ""} unresolved`);
  return `<div class="pageinfo">${pieces.join(" · ")}</div>`;
}

// ---------------------------------------------------------------------------
// template + theme
// ---------------------------------------------------------------------------
const LOGO = `<svg viewBox="0 0 1024 1024" class="mark" aria-hidden="true">
<path fill="#f4a020" d="M498.8,698.8C477.5,699.2 456.7,700.3 435.9,699.7C382.4,698.3 330.1,690.4 280.3,669.8C262.1,662.2 245.1,652.6 229.6,640.1C206.3,621.2 191.5,596.8 183,568.3C179.4,556 175.8,543.6 171.7,529.8C173.5,531.5 174.5,532 175.1,532.8C187.3,551.2 205,562.9 224.6,572C256.4,586.9 290.2,594.7 324.9,599.1C359.5,603.5 394.3,604.6 429.2,602.7C515.7,598.2 599.4,580.6 679.5,547C713.7,532.7 746.3,515.4 775.7,492.5C795,477.5 813.1,461.1 823.7,438.6C828.2,429.1 830.4,418.5 833.3,409.5C835.3,416.6 837.9,425.3 840.3,434.1C845.3,452.7 850.4,471.3 855,490.1C861.5,516.2 856.5,540.3 841.5,562.4C825,587 802.3,605 777.4,620.2C727.7,650.5 673.3,669 616.8,681.9C578.1,690.8 538.9,696.2 498.8,698.8Z"/>
<path fill="#f4a020" d="M440.9,415.1C419.2,411.8 398,408.6 376.1,405.3C383.2,404.2 389.8,403.3 396.4,402.3C428,397.7 459,390.1 489.8,381.4C526.8,371 563.8,360.6 601.2,351.8C637.3,343.3 674.2,340 711.4,342.2C740,343.9 768,348.8 793.2,363.7C807.5,372.2 818.3,383.7 820.4,401C822.1,414.7 817.3,427 810.4,438.5C799.7,456.4 784.3,469.9 767.5,481.8C766.5,482.5 764.7,482.7 763.5,482.3C696.8,458.9 627.5,446.1 558.2,434C519.3,427.3 480.3,421.4 440.9,415.1Z"/>
<path fill="#f4a020" d="M366.5,415.6C392.1,419.1 417.3,422.6 442.4,426C442.5,426.5 442.5,427 442.5,427.5C433.6,430.3 424.8,433.1 416,436C370,451.4 326.6,471.7 289.1,503.1C273.4,516.3 258.9,530.9 249.1,549.3C246.4,554.2 244.3,559.5 241.5,565.6C233,561.4 224.1,557.5 215.6,552.8C204.5,546.6 194.5,538.8 186.9,528.4C174.5,511.5 173.5,493.3 184.3,475.1C194.1,458.8 208.1,447 224.6,438C254,422 285.8,414.9 319.1,414.2C334.7,413.9 350.4,415 366.5,415.6Z"/>
</svg>`;

const SEARCH_SCRIPT = `
var somaSearchIndex=null, somaSearchLoading=null;
function ensureSearchResults(){var box=document.getElementById('search-results');if(!box){box=document.createElement('ul');box.id='search-results';box.setAttribute('role','listbox');document.querySelector('.search').appendChild(box);}return box;}
function escSearch(s){return s.replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function loadSearchIndex(){if(somaSearchIndex)return Promise.resolve(somaSearchIndex);if(!somaSearchLoading){somaSearchLoading=fetch('search-index.json').then(function(r){return r.json();}).then(function(d){somaSearchIndex=d;return d;});}return somaSearchLoading;}
function searchScore(e,q){var t=e.title.toLowerCase(),d=(e.description||'').toLowerCase(),x=(e.text||'').toLowerCase();if(t===q)return 1000;if(t.indexOf(q)>=0)return 700;if(d.indexOf(q)>=0)return 450;if(x.indexOf(q)>=0)return 200;return 0;}
function snippet(e,q){var text=e.text||'',lower=text.toLowerCase(),pos=lower.indexOf(q);if(pos<0)return escSearch((e.description||text).slice(0,140));var s=Math.max(0,pos-55),en=Math.min(text.length,pos+q.length+85);return (s?'… ':'')+escSearch(text.slice(s,pos))+'<mark>'+escSearch(text.slice(pos,pos+q.length))+'</mark>'+escSearch(text.slice(pos+q.length,en))+(en<text.length?' …':'');}
function renderSearch(q){var box=ensureSearchResults();if(!q){box.classList.remove('open');box.innerHTML='';return;}loadSearchIndex().then(function(index){var hits=index.map(function(e){return {e:e,s:searchScore(e,q)};}).filter(function(h){return h.s>0;}).sort(function(a,b){return b.s-a.s||a.e.title.localeCompare(b.e.title);}).slice(0,8);if(!hits.length){box.innerHTML='<li class="empty">No matches</li>';box.classList.add('open');return;}box.innerHTML=hits.map(function(h){return '<li><a href="'+h.e.slug+'.html"><b>'+escSearch(h.e.title)+'</b><span>'+snippet(h.e,q)+'</span></a></li>';}).join('');box.classList.add('open');});}
function somaSearch(ev){ev.preventDefault();var q=document.getElementById('q').value.trim().toLowerCase();if(!q)return false;loadSearchIndex().then(function(index){var hit=index.map(function(e){return {e:e,s:searchScore(e,q)};}).filter(function(h){return h.s>0;}).sort(function(a,b){return b.s-a.s;})[0];if(hit)window.location=hit.e.slug+'.html';});return false;}
document.addEventListener('DOMContentLoaded',function(){var q=document.getElementById('q');var box=ensureSearchResults();q.addEventListener('input',function(){renderSearch(q.value.trim().toLowerCase());});q.addEventListener('keydown',function(e){if(e.key==='Enter')somaSearch(e);if(e.key==='Escape')box.classList.remove('open');});document.addEventListener('click',function(e){if(!e.target.closest('.search'))box.classList.remove('open');});});
`;

const SITE_CSS = `:root{--amber:#f4a020;--amber-deep:#E0513A;--link:#0645ad;--link-visited:#0b0080;--link-new:#ba0000;--ink:#202122;--muted:#54595d;--rule:#a2a9b1;--rule-soft:#c8ccd1;--panel:#f8f9fa}
*{box-sizing:border-box}html{font-size:16px}
body{margin:0;color:var(--ink);background:#f6f6f4;font-family:Inter,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif}
#layout{display:flex;align-items:flex-start;max-width:1230px;margin:0 auto;background:#fff;min-height:100vh;box-shadow:0 0 0 1px #eaecf0}
#sidebar{width:210px;flex:0 0 210px;padding:14px 12px 30px;background:#fff;border-right:1px solid var(--rule-soft);position:sticky;top:0;align-self:stretch}
.logo{display:flex;align-items:center;gap:9px;text-decoration:none;color:var(--ink);padding:4px 4px 14px}
.logo .mark{width:38px;height:38px;flex:0 0 38px}
.wordmark{font-size:14px;line-height:1.15;letter-spacing:.2px}.wordmark b{font-weight:700}
.search{margin:0 2px 16px;position:relative}
.search input{width:100%;padding:6px 8px;border:1px solid var(--rule);border-radius:2px;font-size:13px;outline:none}
.search input:focus{border-color:var(--amber);box-shadow:0 0 0 2px rgba(244,160,32,.25)}
#search-results{display:none;position:absolute;z-index:20;left:0;right:0;top:30px;list-style:none;margin:0;padding:4px;background:#fff;border:1px solid var(--rule);box-shadow:0 8px 24px rgba(32,33,34,.18);max-height:360px;overflow:auto}
#search-results.open{display:block}#search-results li{margin:0;padding:0}
#search-results li.empty{padding:8px;font-size:12.5px;color:var(--muted)}
#search-results a{display:block;padding:7px 8px;border-radius:2px;color:var(--ink);text-decoration:none;font-size:12.5px;line-height:1.35}
#search-results a:hover{background:#fbf3e3}#search-results b{display:block;font-size:13px;margin-bottom:2px}
#search-results span{display:block;color:var(--muted)}#search-results mark{background:#ffe2a8;color:inherit;padding:0 .08em}
.portlet{margin-bottom:14px}
.portlet h3{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);font-weight:600;margin:0 0 4px;padding:0 4px}
.portlet ul{list-style:none;margin:0;padding:0}
.portlet li a{display:block;padding:3px 8px;font-size:13.5px;color:var(--link);text-decoration:none;border-radius:2px}
.portlet li a:hover{text-decoration:underline;background:var(--panel)}
.portlet li a.active{color:var(--ink);font-weight:600;background:#fbf3e3;box-shadow:inset 2px 0 0 var(--amber)}
.sidebar-foot{margin-top:22px;padding:10px 6px 0;border-top:1px solid var(--rule-soft);font-size:11px;color:var(--muted);line-height:1.5}
#content{flex:1 1 auto;min-width:0;padding:8px 34px 60px}
.tabs{display:flex;align-items:flex-end;gap:2px;border-bottom:1px solid var(--rule);margin:4px 0 0;font-size:12.5px}
.tab{padding:6px 12px 7px;color:var(--link);background:var(--panel);border:1px solid var(--rule-soft);border-bottom:none;border-radius:3px 3px 0 0;position:relative;top:1px}
.tab.active{background:#fff;color:var(--ink);border-bottom:1px solid #fff;box-shadow:0 -2px 0 var(--amber) inset}
.tab-spacer{flex:1 1 auto;border-bottom:1px solid var(--rule);align-self:stretch}
.firstHeading{font-family:Georgia,"Times New Roman",serif;font-weight:400;font-size:30px;margin:14px 0 0;padding-bottom:6px;border-bottom:1px solid var(--rule);line-height:1.25}
.tagline{font-size:13px;color:var(--muted);font-style:italic;margin:4px 0 14px}
.pageinfo{font-family:Inter,sans-serif;font-size:12px;color:var(--muted);margin:-6px 0 14px}
.stale-banner{font-family:Inter,sans-serif;font-size:13px;color:#3a2b12;background:#fff4d8;border-left:4px solid var(--amber-deep);padding:8px 11px;margin:0 0 14px}
#bodyContent{font-family:Georgia,"Times New Roman",serif;font-size:15.5px;line-height:1.62;color:var(--ink);max-width:62rem}
#bodyContent p{margin:.65em 0}
#bodyContent h2{font-family:Georgia,serif;font-weight:400;font-size:23px;border-bottom:1px solid var(--rule-soft);padding-bottom:4px;margin:1.4em 0 .5em}
#bodyContent h3{font-family:Georgia,serif;font-weight:700;font-size:17.5px;margin:1.2em 0 .4em}
#bodyContent h4{font-family:Inter,sans-serif;font-size:14px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin:1.1em 0 .3em}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}a:visited{color:var(--link-visited)}a.new{color:var(--link-new)}
.anchor{margin-left:.4em;color:var(--rule);font-size:.7em;opacity:0;text-decoration:none}
h2:hover .anchor,h3:hover .anchor{opacity:1}
#bodyContent ul,#bodyContent ol{margin:.5em 0;padding-left:1.6em}#bodyContent li{margin:.22em 0}
code{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em;background:var(--panel);border:1px solid #eaecf0;border-radius:3px;padding:.08em .35em}
pre{background:#1f2329;color:#e6e6e6;border:1px solid #d0d0d0;border-left:3px solid var(--amber);border-radius:4px;padding:13px 15px;overflow:auto;margin:.9em 0;line-height:1.5}
pre code{background:none;border:none;color:inherit;padding:0;font-size:12.8px}
table.wikitable{border-collapse:collapse;margin:1em 0;font-family:Inter,sans-serif;font-size:13.5px;background:#fff;border:1px solid var(--rule)}
table.wikitable th{background:#eaf0f3;border:1px solid var(--rule-soft);padding:7px 11px;text-align:left;font-weight:600}
table.wikitable td{border:1px solid var(--rule-soft);padding:6px 11px;vertical-align:top}
table.wikitable tr:nth-child(even) td{background:#fbfbfb}
blockquote{margin:1em 0;padding:.5em 16px;background:#fbf6ec;border-left:4px solid var(--amber);color:#3a3a36}blockquote p{margin:.2em 0}
.toc{display:inline-block;min-width:240px;max-width:420px;background:var(--panel);border:1px solid var(--rule-soft);border-radius:3px;padding:10px 16px 12px;margin:6px 0 14px;font-family:Inter,sans-serif;font-size:13px}
.toctitle{font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin-bottom:6px;text-align:center}
.toc ul{list-style:none;margin:0;padding:0}.toc li{margin:2px 0}.toc .toclevel-2{padding-left:18px}.toc .tocnumber{color:var(--muted);margin-right:5px}
.backlinks{margin-top:28px;padding:11px 14px;background:var(--panel);border:1px solid var(--rule-soft);border-left:3px solid var(--amber);font-family:Inter,sans-serif;font-size:13px}
.backlinks .box-title{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);font-weight:700;margin-bottom:4px}
.backlinks ul{margin:0;padding-left:1.4em}.backlinks li{margin:2px 0}
hr{border:none;border-top:1px solid var(--rule-soft);margin:1.5em 0}
.printfooter{margin-top:38px;padding-top:10px;border-top:1px solid var(--rule-soft);font-family:Inter,sans-serif;font-size:11.5px;color:var(--muted)}
@media(max-width:880px){#layout{flex-direction:column}#sidebar{width:100%;flex-basis:auto;position:static;border-right:none;border-bottom:1px solid var(--rule-soft)}#content{padding:8px 18px 40px}}`;

function navSections(pages, config) {
  const num = (x) => (x != null && Number.isFinite(Number(x)) ? Number(x) : 100);
  const groups = new Map();
  for (const p of pages) {
    const section = p.meta.section || "Pages";
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section).push(p);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => (num(a.meta.order) - num(b.meta.order)) || a.title.localeCompare(b.title));
  }
  const pref = config.sectionOrder || [];
  const sections = [...groups.keys()].sort((a, b) => {
    const ia = pref.indexOf(a);
    const ib = pref.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    return a.localeCompare(b);
  });
  return sections.map((s) => ({ section: s, items: groups.get(s) }));
}

function renderNav(pages, currentSlug, config) {
  return navSections(pages, config).map(({ section, items }) => {
    const lis = items.map((p) => {
      const label = p.meta.nav_label || p.title;
      const active = p.slug === currentSlug ? ' class="active"' : "";
      return `<li><a href="${htmlFileForSlug(p.slug)}"${active}>${escapeHtml(label)}</a></li>`;
    }).join("");
    return `<div class="portlet"><h3>${escapeHtml(section)}</h3><ul>${lis}</ul></div>`;
  }).join("\n");
}

function renderPage(page, pages, ctx, config, backlinks, titles) {
  const toc = [];
  const body = renderMarkdown(page.body, ctx, toc);
  const tocHtml = renderToc(toc);
  const updated = pageMtime(path.join(ctx.wiki, page.file));
  const freshness = ctx.skipProvenance ? { entries: [], missing: [], latest: null } : sourceFreshness(page.sources, ctx.root);
  const stale = Boolean(freshness.latest && freshness.latest.date > updated);
  const navHtml = renderNav(pages, page.slug, config);
  const backlinksHtml = renderBacklinks(page.slug, backlinks, titles);
  const provenanceHtml = renderProvenance(updated, freshness);
  const staleHtml = stale ? `<div class="stale-banner">A source file changed after this page was last updated. Treat this page as a refresh candidate.</div>` : "";
  const [wmTop, wmBottom] = wordmark(config);
  const subtitle = page.slug === "index" ? `${config.tagline}` : `${config.tagline}`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.title)} — ${escapeHtml(config.title)}</title>
<meta name="description" content="${escapeHtml(page.description)}">
<link rel="stylesheet" href="style.css">
</head>
<body>
<div id="layout">
  <aside id="sidebar">
    <a class="logo" href="index.html">${LOGO}<span class="wordmark">${escapeHtml(wmTop)}<br><b>${escapeHtml(wmBottom)}</b></span></a>
    <form class="search" onsubmit="return somaSearch(event)">
      <input id="q" type="search" placeholder="Search this wiki" autocomplete="off">
    </form>
    <nav>${navHtml}</nav>
    <div class="sidebar-foot">${escapeHtml(config.tagline)}</div>
  </aside>
  <main id="content">
    <div class="tabs">
      <span class="tab active">Page</span>
      <span class="tab">Discussion</span>
      <span class="tab-spacer"></span>
      <span class="tab">Read</span>
      <span class="tab">Source</span>
      <span class="tab">History</span>
    </div>
    <h1 class="firstHeading">${escapeHtml(page.title)}</h1>
    <div class="tagline">${escapeHtml(subtitle)}</div>
    ${provenanceHtml}
    ${staleHtml}
    <div id="bodyContent">
      ${tocHtml}
      ${body}
      ${backlinksHtml}
    </div>
    <div class="printfooter">Mirrored from <code>.wiki/${escapeHtml(page.file)}</code> · auto-maintained by Wikify.</div>
  </main>
</div>
<script>${SEARCH_SCRIPT}</script>
</body>
</html>`;
  return { html, stale, freshness, outbound: ctx.outbound.get(page.slug) || [] };
}

function wordmark(config) {
  const title = config.title || "Wiki";
  const words = title.split(/\s+/);
  if (words.length === 1) return [words[0], "Wiki"];
  return [words.slice(0, -1).join(" "), words[words.length - 1]];
}

// ---------------------------------------------------------------------------
// page collection + build
// ---------------------------------------------------------------------------
function collectWikiPages(root) {
  const wiki = path.join(root, ".wiki");
  if (!fs.existsSync(wiki)) return [];
  const files = (fs.readdirSync(wiki, { recursive: true }) as string[])
    .filter((file) => typeof file === "string" && file.endsWith(".md"))
    .filter((file) => !file.replace(/\\/g, "/").startsWith("_site/"))
    .filter((file) => !file.replace(/\\/g, "/").startsWith("_imported/"))
    .sort();
  const pages = files.map((file) => {
    const raw = fs.readFileSync(path.join(wiki, file), "utf8");
    const [meta, body] = parseFrontmatter(raw);
    const slug = slugForFile(file);
    return {
      file: file.replace(/\\/g, "/"),
      slug,
      title: meta.title || titleFromSlug(slug),
      description: meta.description || "",
      meta,
      sources: splitSources(meta.sources),
      body,
      raw,
    };
  });
  // slug collision detection
  const seen = new Map();
  const collisions = [];
  for (const p of pages) {
    if (seen.has(p.slug)) collisions.push(`${seen.get(p.slug)} <-> ${p.file} (both -> ${p.slug}.html)`);
    else seen.set(p.slug, p.file);
  }
  if (collisions.length) {
    console.error("Slug collisions (rename one of each pair):\n  " + collisions.join("\n  "));
    process.exit(1);
  }
  return pages;
}

function plainText(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}

function buildSite(root, opts = {}) {
  const wiki = path.join(root, ".wiki");
  if (!fs.existsSync(wiki)) {
    console.error(missingWikiMessage(root));
    process.exitCode = 1;
    return;
  }
  const config = loadConfig(root);
  const out = path.join(wiki, "_site");
  fs.mkdirSync(out, { recursive: true });
  const pages = collectWikiPages(root);
  const pagesBySlug = new Map(pages.map((p) => [p.slug, p]));
  const titles = new Map(pages.map((p) => [p.slug, p.title]));

  // link graph
  const backlinks = new Map();
  const outbound = new Map();
  for (const p of pages) {
    const links = collectLinks(p.body, pagesBySlug);
    outbound.set(p.slug, [...links].sort());
    for (const t of links) {
      if (!backlinks.has(t)) backlinks.set(t, new Set());
      backlinks.get(t).add(p.slug);
    }
  }

  const ctx = {
    root,
    wiki,
    pagesBySlug,
    outbound,
    githubRepos: config.githubRepos || {},
    ticketPage: config.ticketPage,
    hasTicketPage: pagesBySlug.has(config.ticketPage),
    ticketDenylist: new Set(config.ticketDenylist || []),
    skipProvenance: Boolean(opts["skip-provenance"]),
  };

  const searchIndex = [];
  const graph = { nodes: [], links: [] };

  for (const page of pages) {
    const { html, stale } = renderPage(page, pages, ctx, config, backlinks, titles);
    fs.writeFileSync(path.join(out, htmlFileForSlug(page.slug)), html);
    const toc = [];
    const bodyHtml = renderMarkdown(page.body, ctx, toc);
    const headings = toc.map((t) => t.text).join(" ");
    searchIndex.push({
      slug: page.slug,
      title: page.title,
      description: page.description,
      text: `${headings} ${plainText(bodyHtml)}`.slice(0, 2200),
    });
    graph.nodes.push({
      slug: page.slug,
      title: page.title,
      sources: page.sources,
      backlinks: (backlinks.get(page.slug) || new Set()).size,
      outbound: (outbound.get(page.slug) || []).length,
      stale,
    });
    for (const t of outbound.get(page.slug) || []) graph.links.push({ source: page.slug, target: t });
  }

  fs.writeFileSync(path.join(out, "style.css"), SITE_CSS);
  fs.writeFileSync(path.join(out, "search-index.json"), JSON.stringify(searchIndex.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase())), null, 2));
  fs.writeFileSync(path.join(out, "graph.json"), JSON.stringify(graph, null, 2));
  console.log(`Built ${pages.length} pages -> ${out}`);
  const repos = Object.keys(ctx.githubRepos);
  if (repos.length) console.log(`GitHub repos detected: ${repos.join(", ")}`);
}

// ---------------------------------------------------------------------------
// health + audit
// ---------------------------------------------------------------------------
function memoryStats(root) {
  const pages = collectWikiPages(root);
  const pagesBySlug = new Map(pages.map((p) => [p.slug, p]));
  let totalLinks = 0;
  const backlinks = new Map();
  for (const p of pages) {
    const links = collectLinks(p.body, pagesBySlug);
    totalLinks += links.size;
    for (const t of links) {
      if (!backlinks.has(t)) backlinks.set(t, new Set());
      backlinks.get(t).add(p.slug);
    }
  }
  const sourced = pages.filter((p) => p.sources.length).length;
  const gotchas = (pagesBySlug.get("gotchas")?.body.match(/^##\s+/gm) || []).length;
  const todos = (pagesBySlug.get("todos")?.body.match(/- /g) || []).length;
  const decisions = (pagesBySlug.get("decisions")?.body.match(/## /g) || []).length;
  const orphans = pages.filter((p) => p.slug !== "index" && !(backlinks.get(p.slug)?.size));

  let score = 35;
  score += Math.min(20, totalLinks);
  score += Math.min(15, sourced * 3);
  score += gotchas ? 10 : 0;
  score += todos ? 10 : 0;
  score += decisions ? 10 : 0;
  score -= Math.min(20, orphans.length * 4);
  score = Math.max(0, Math.min(100, score));

  return { pages, totalLinks, sourced, gotchas, todos, decisions, orphans, score };
}

function health(root) {
  const wiki = path.join(root, ".wiki");
  if (!fs.existsSync(wiki)) {
    console.error(missingWikiMessage(root));
    process.exitCode = 1;
    return;
  }
  const stats = memoryStats(root);
  const { pages, totalLinks, sourced, gotchas, todos, decisions, orphans, score } = stats;

  console.log(`Repo Memory Score: ${score}/100\n`);
  console.log("Found:");
  console.log(`- ${pages.length} wiki pages`);
  console.log(`- ${totalLinks} internal wiki links`);
  console.log(`- ${sourced} pages with source provenance`);
  console.log(`- ${todos} persistent todo bullets`);
  console.log(`- ${gotchas} known gotcha sections`);
  console.log(`- ${decisions} decision sections`);
  console.log("\nMissing:");
  console.log(orphans.length ? `- Backlinks for: ${orphans.map((p) => p.title).join(", ")}` : "- No obvious orphan pages");
  console.log("\nNext:");
  console.log("- Run `wikify build` after wiki edits");
  console.log("- Run `wikify audit` before publishing");
}

const AUDIT_PATTERNS = [
  { name: "private key", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\bgh[posru]_[A-Za-z0-9]{20,}\b/ },
  { name: "generic secret assignment", re: /\b(?:api[_-]?key|secret|password|passwd|token|bearer)\b\s*[:=]\s*['"]?[A-Za-z0-9_\-]{12,}/i },
  { name: "email address", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
];

function audit(root) {
  const wiki = path.join(root, ".wiki");
  if (!fs.existsSync(wiki)) {
    console.error(missingWikiMessage(root));
    process.exitCode = 1;
    return;
  }
  const files = (fs.readdirSync(wiki, { recursive: true }) as string[])
    .filter((f) => typeof f === "string" && f.endsWith(".md") && !f.replace(/\\/g, "/").startsWith("_site/"));
  let findings = 0;
  for (const f of files) {
    const lines = fs.readFileSync(path.join(wiki, f), "utf8").split("\n");
    lines.forEach((line, idx) => {
      for (const pat of AUDIT_PATTERNS) {
        if (pat.re.test(line)) {
          findings += 1;
          console.log(`  ${f}:${idx + 1}  [${pat.name}]  ${line.trim().slice(0, 100)}`);
        }
      }
    });
  }
  if (findings) {
    console.log(`\n${findings} potential issue(s) found. Never commit secrets/keys/internal IDs to .wiki/.`);
    process.exitCode = 1;
  } else {
    console.log("audit: no secrets, keys, or emails detected in .wiki/*.md");
  }
}

// ---------------------------------------------------------------------------
// share / serve / connect / update
// ---------------------------------------------------------------------------
function normalizedBaseUrl(value) {
  if (!value) return null;
  return String(value).trim().replace(/\/+$/, "");
}

function shareBadgeSvg(title, stats) {
  const safeTitle = escapeHtml(title);
  const width = 620;
  const score = `${stats.score}/100`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="180" viewBox="0 0 ${width} 180" role="img" aria-label="Wikify Repo Memory ${score}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fff8e8"/>
      <stop offset="1" stop-color="#f8f9fa"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="180" rx="8" fill="url(#g)"/>
  <rect x="0.5" y="0.5" width="${width - 1}" height="179" rx="7.5" fill="none" stroke="#c8ccd1"/>
  <circle cx="54" cy="54" r="28" fill="#f4a020"/>
  <path d="M37 56c12 10 38 10 55-7-6 23-49 32-70 14 4 2 8 3 15 3Z" fill="#fff"/>
  <text x="92" y="42" fill="#202122" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="20" font-weight="700">${safeTitle}</text>
  <text x="92" y="66" fill="#54595d" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="13">Repo memory generated by Wikify</text>
  <text x="498" y="62" fill="#202122" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="34" font-weight="800" text-anchor="middle">${score}</text>
  <text x="498" y="84" fill="#54595d" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="12" text-anchor="middle">memory score</text>
  <line x1="32" y1="106" x2="${width - 32}" y2="106" stroke="#eaecf0"/>
  <text x="38" y="136" fill="#202122" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="14">${stats.pages.length} pages</text>
  <text x="160" y="136" fill="#202122" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="14">${stats.totalLinks} links</text>
  <text x="278" y="136" fill="#202122" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="14">${stats.decisions} decisions</text>
  <text x="410" y="136" fill="#202122" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="14">${stats.gotchas} gotchas</text>
  <text x="38" y="160" fill="#54595d" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="12">Static, repo-owned, agent-readable Markdown plus human-readable HTML.</text>
</svg>
`;
}

function shareHtml(config, stats, baseUrl) {
  const badgeUrl = baseUrl ? `${baseUrl}/wikify-badge.svg` : "wikify-badge.svg";
  const indexUrl = baseUrl ? `${baseUrl}/index.html` : "index.html";
  const markdownSnippet = `[![Wikify Repo Memory](${badgeUrl})](${indexUrl})`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Share ${escapeHtml(config.title)}</title>
<meta name="description" content="Shareable Wikify repo memory card for ${escapeHtml(config.title)}.">
<style>
body{margin:0;background:#f6f6f4;color:#202122;font-family:Inter,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:760px;margin:0 auto;padding:42px 22px}
h1{font-size:28px;line-height:1.2;margin:0 0 8px}
p{color:#54595d;line-height:1.55}
.badge{display:block;max-width:100%;height:auto;margin:24px 0;border-radius:8px}
.panel{border:1px solid #c8ccd1;background:#fff;border-radius:8px;padding:16px;margin-top:18px}
code,pre{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
pre{white-space:pre-wrap;overflow:auto;background:#1f2329;color:#e6e6e6;border-radius:6px;padding:14px}
a{color:#0645ad}
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(config.title)}</h1>
  <p>This repo has a Wikify memory: source-of-truth Markdown for agents and a static HTML mirror for humans.</p>
  <a href="${indexUrl}"><img class="badge" src="${badgeUrl}" alt="Wikify Repo Memory ${stats.score}/100"></a>
  <div class="panel">
    <strong>README badge</strong>
    <pre>${escapeHtml(markdownSnippet)}</pre>
  </div>
  <div class="panel">
    <strong>Static files</strong>
    <p>Publish the contents of <code>.wiki/_site/</code> with GitHub Pages, Netlify, Vercel, Cloudflare Pages, or any static host.</p>
  </div>
</main>
</body>
</html>
`;
}

function share(root, opts: any = {}) {
  const wiki = path.join(root, ".wiki");
  if (!fs.existsSync(wiki)) {
    console.error(missingWikiMessage(root));
    process.exitCode = 1;
    return;
  }

  buildSite(root, opts);

  const config = loadConfig(root);
  const stats = memoryStats(root);
  const site = path.join(wiki, "_site");
  const baseUrl = normalizedBaseUrl(opts["base-url"]);
  const indexUrl = baseUrl ? `${baseUrl}/index.html` : path.join(site, "index.html");
  const badgeUrl = baseUrl ? `${baseUrl}/wikify-badge.svg` : path.join(site, "wikify-badge.svg");
  const markdownSnippet = `[![Wikify Repo Memory](${badgeUrl})](${indexUrl})`;

  fs.writeFileSync(path.join(site, ".nojekyll"), "");
  fs.writeFileSync(path.join(site, "wikify-badge.svg"), shareBadgeSvg(config.title, stats));
  fs.writeFileSync(path.join(site, "share.html"), shareHtml(config, stats, baseUrl));
  fs.writeFileSync(path.join(site, "share.json"), JSON.stringify({
    title: config.title,
    generatedAt: new Date().toISOString(),
    score: stats.score,
    pages: stats.pages.length,
    links: stats.totalLinks,
    sourcedPages: stats.sourced,
    todos: stats.todos,
    gotchas: stats.gotchas,
    decisions: stats.decisions,
    orphanPages: stats.orphans.map((p) => p.slug),
    indexUrl,
    badgeUrl,
  }, null, 2));

  console.log(`Share assets written to ${site}`);
  console.log(`- ${path.join(site, "wikify-badge.svg")}`);
  console.log(`- ${path.join(site, "share.html")}`);
  console.log(`- ${path.join(site, "share.json")}`);
  console.log("\nREADME badge:");
  console.log(markdownSnippet);
  console.log("\nPublish the contents of .wiki/_site/ to any static host.");
  if (!baseUrl) console.log("Pass --base-url after hosting to generate absolute badge links.");
}

function serve(root, port) {
  const site = path.join(root, ".wiki/_site");
  const wiki = path.join(root, ".wiki");
  if (!fs.existsSync(wiki)) {
    console.error(missingWikiMessage(root));
    process.exitCode = 1;
    return;
  }
  const base = fs.existsSync(site) ? site : wiki;
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".md": "text/plain; charset=utf-8" };
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, `http://localhost:${port}`).pathname);
    const file = pathname === "/" ? (base === site ? "index.html" : "index.md") : pathname.slice(1);
    const fullPath = path.normalize(path.join(base, file));
    if (!fullPath.startsWith(base) || !fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    res.setHeader("Content-Type", types[path.extname(fullPath)] || "application/octet-stream");
    res.end(fs.readFileSync(fullPath));
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Wikify serving ${base} at http://127.0.0.1:${port}/`);
  });
}

function connect(root, provider, opts: any = {}) {
  if (provider !== "github") {
    console.error("Only `wikify connect github` is defined.");
    process.exitCode = 1;
    return;
  }

  const wiki = path.join(root, ".wiki");
  if (!fs.existsSync(wiki)) {
    console.error(missingWikiMessage(root));
    process.exitCode = 1;
    return;
  }

  const ghRepo = githubRepoForRoot(root);
  if (!ghRepo) {
    console.error("Could not detect a GitHub origin remote for this repository.");
    console.error("Set the repo origin to github.com or run from a GitHub-backed repository.");
    process.exitCode = 1;
    return;
  }

  const limit = prLimit(opts);
  console.log(`Importing up to ${limit} closed PRs from ${ghRepo.owner}/${ghRepo.repo}...`);
  const pulls = fetchGithubPulls(ghRepo.owner, ghRepo.repo, limit);
  if (process.exitCode) return;

  const importedAt = new Date();
  const rawDir = path.join(wiki, "_imported");
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, "github-prs.json"), JSON.stringify({
    source: `https://github.com/${ghRepo.owner}/${ghRepo.repo}`,
    importedAt: importedAt.toISOString(),
    note: "Raw imported PR data is untrusted and gitignored. Use .wiki/prs-and-tickets.md as the durable reviewed summary.",
    pulls,
  }, null, 2));

  upsertMarkdownSection(
    path.join(wiki, "prs-and-tickets.md"),
    "GitHub PR changelog",
    changelogMarkdown(ghRepo.owner, ghRepo.repo, pulls, importedAt)
  );

  buildSite(root, opts);
  const merged = pulls.filter((pr) => pr.merged_at).length;
  console.log(`Imported ${merged} merged PRs into ${path.join(wiki, "prs-and-tickets.md")}`);
  console.log(`Raw PR JSON quarantined in ${path.join(rawDir, "github-prs.json")}`);
}

function update(root, opts) {
  if (opts["pr-history"]) { connect(root, "github", opts); return; }
  buildSite(root, opts);
  health(root);
}

// ---------------------------------------------------------------------------
// test ledger
// ---------------------------------------------------------------------------
// Parse the summary counters from a TAP stream (node --test --test-reporter=tap).
function parseTap(tap) {
  const num = (re) => { const m = tap.match(re); return m ? Number(m[1]) : 0; };
  return {
    tests: num(/^# tests (\d+)/m),
    pass: num(/^# pass (\d+)/m),
    fail: num(/^# fail (\d+)/m),
    skipped: num(/^# (?:skipped|skip) (\d+)/m),
    todo: num(/^# todo (\d+)/m),
  };
}

// Count test files (*.test.* / *.spec.*) under the configured globs.
function countTestFiles(root, dirs) {
  let count = 0;
  for (const d of dirs) {
    const abs = path.join(root, d);
    if (!fs.existsSync(abs)) continue;
    const entries = fs.readdirSync(abs, { recursive: true }) as string[];
    for (const e of entries) {
      if (typeof e === "string" && /\.(test|spec)\.[cm]?[jt]s$/.test(e)) count += 1;
    }
  }
  return count;
}

function testStatsTable(stats, files, when) {
  const status = stats.fail > 0 ? "❌ failing" : "✅ passing";
  return [
    `Last run: ${when} — **${status}**`,
    "",
    "| Metric | Count |",
    "| --- | --- |",
    `| Total tests | ${stats.tests} |`,
    `| Passing | ${stats.pass} |`,
    `| Failing | ${stats.fail} |`,
    `| Skipped | ${stats.skipped} |`,
    `| Todo | ${stats.todo} |`,
    `| Test files | ${files} |`,
  ].join("\n");
}

// Run the suite, parse results, and mechanically rewrite the Stats block in
// .wiki/tests.md. Numbers come straight from the run, never from a human.
function runTests(root, opts) {
  const wiki = path.join(root, ".wiki");
  if (!fs.existsSync(wiki)) {
    console.error(missingWikiMessage(root));
    process.exitCode = 1;
    return;
  }
  const cfg = loadConfig(root);
  const [cmd, ...cmdArgs] = cfg.testCommand;
  let tap = "";
  let runFailed = false;
  try {
    tap = execFileSync(cmd, cmdArgs, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) as string;
  } catch (err: any) {
    // Non-zero exit is expected when tests fail; the TAP body is still on stdout.
    tap = (err.stdout?.toString() || "") + (err.stderr?.toString() || "");
    runFailed = true;
  }
  const stats = parseTap(tap);
  const files = countTestFiles(root, cfg.testGlobs);
  const when = opts["run-label"] || fmtDateTime(new Date());

  const ledger = path.join(wiki, "tests.md");

  // --check (CI gate): compare the committed numbers to this fresh run without
  // writing anything. Ignores the volatile "Last run" line — only the metrics.
  if (opts.check) {
    const committed = fs.existsSync(ledger) ? extractLedgerStats(fs.readFileSync(ledger, "utf8")) : null;
    const fresh = { tests: stats.tests, pass: stats.pass, fail: stats.fail, skipped: stats.skipped, todo: stats.todo, files };
    const drift = !committed || (Object.keys(fresh) as (keyof typeof fresh)[]).filter((k) => committed[k] !== fresh[k]);
    if (!committed) {
      console.error("Ledger has no recorded numbers. Run `wikify test` and commit .wiki/tests.md.");
      process.exitCode = 1;
    } else if (Array.isArray(drift) && drift.length) {
      console.error("Test ledger is stale. Run `wikify test` and commit .wiki/tests.md.");
      for (const k of drift) console.error(`  ${k}: ledger=${committed[k]} actual=${fresh[k]}`);
      process.exitCode = 1;
    } else {
      console.log(`Test ledger is current: ${fresh.pass}/${fresh.tests} passing, ${fresh.fail} failing, ${files} file(s).`);
    }
    if (runFailed || stats.fail > 0) process.exitCode = 1;
    return;
  }

  if (!fs.existsSync(ledger)) {
    fs.writeFileSync(ledger, wikiPage("Test ledger", "Authoritative record of automated tests and their numbers.", testLedgerBody(), { section: "Wikify", order: 3 }));
  }
  const result = upsertManagedBlock(ledger, TEST_STATS_START, TEST_STATS_END, testStatsTable(stats, files, when));

  console.log(`Test ledger ${result}: ${stats.pass}/${stats.tests} passing, ${stats.fail} failing, ${files} file(s).`);
  if (opts["skip-build"] !== true) buildSite(root, { ...opts, "skip-provenance": true });
  if (runFailed || stats.fail > 0) {
    console.error("Tests failed. Ledger updated to reflect the failing run.");
    process.exitCode = 1;
  }
}

// Read the metric numbers back out of a ledger's Stats table (inverse of
// testStatsTable). Returns null if the table isn't present.
function extractLedgerStats(text) {
  const row = (label) => { const m = text.match(new RegExp(`\\|\\s*${label}\\s*\\|\\s*(\\d+)\\s*\\|`)); return m ? Number(m[1]) : null; };
  const tests = row("Total tests");
  if (tests === null) return null;
  return {
    tests,
    pass: row("Passing") ?? 0,
    fail: row("Failing") ?? 0,
    skipped: row("Skipped") ?? 0,
    todo: row("Todo") ?? 0,
    files: row("Test files") ?? 0,
  };
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------
export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0];
  const root = path.resolve(args.root || process.cwd());

  if (!command || command === "--help" || command === "help") {
    usage();
  } else if (command === "init") {
    initWiki(root, args);
  } else if (command === "build") {
    buildSite(root, args);
  } else if (command === "health") {
    health(root);
  } else if (command === "test") {
    runTests(root, args);
  } else if (command === "audit") {
    audit(root);
  } else if (command === "share") {
    share(root, args);
  } else if (command === "serve") {
    serve(root, Number(args.port || 4173));
  } else if (command === "connect") {
    connect(root, args._[1], args);
  } else if (command === "update") {
    update(root, args);
  } else {
    console.error(`Unknown command: ${command}`);
    usage();
    process.exitCode = 1;
  }
}

// Named exports for unit testing. The CLI behaviour lives in main(), invoked by
// the bin shim; importing this module has no side effects.
export {
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
  initWiki,
  buildSite,
  health,
  audit,
  AUDIT_PATTERNS,
  runTests,
  parseTap,
  countTestFiles,
  extractLedgerStats,
};
