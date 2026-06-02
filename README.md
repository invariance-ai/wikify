# Wikify

Give your repo a memory.

`@invariance/wikify` installs a living `.wiki/` folder plus agent-native instructions for
Claude Code, Codex, Cursor, OpenCode, and shell-based agents.

On init, Wikify creates both sides of the wiki:

- `.wiki/*.md` — source-of-truth Markdown for agents and git review
- `.wiki/_site/*.html` — generated human-readable HTML mirror for local or hosted browsing
- `.wiki/wiki.md` — wiki authoring preferences for agents

The unscoped npm name `wikify` is already occupied, so this package publishes as
`@invariance/wikify` while exposing the command `wikify`.

## Install

Website-style install:

```bash
curl -fsSL https://wikify.dev/install.sh | sh
```

Until `wikify.dev` is live:

```bash
curl -fsSL https://raw.githubusercontent.com/invariance-ai/wikify/main/install.sh | sh
```

Without PR history:

```bash
curl -fsSL https://raw.githubusercontent.com/invariance-ai/wikify/main/install.sh | WIKIFY_PR_HISTORY=without sh
```

Only Claude Code:

```bash
curl -fsSL https://raw.githubusercontent.com/invariance-ai/wikify/main/install.sh | WIKIFY_AGENTS=claude sh
```

NPM:

```bash
npx @invariance/wikify init --agents claude,codex,cursor,opencode --with-pr-history
```

Local-only:

```bash
npx @invariance/wikify init --agents claude,codex,cursor,opencode --no-pr-history
```

## Commands

```bash
wikify init
wikify build
wikify init --agent claude --with-pr-history
wikify init --agent codex --no-pr-history
wikify connect github --pr-limit 500
npx @invariance/wikify health
wikify serve
```

Agent rule: if `.wiki/index.md` is missing, run `wikify init`. That command creates
the starter wiki pages under `.wiki/`, renders `.wiki/_site/`, and installs any requested
agent wiring.

Command meanings:

- `wikify init` creates missing `.wiki/*.md` source pages and renders the HTML mirror.
- `wikify build` regenerates `.wiki/_site/` from existing `.wiki/*.md` pages.
- `wikify serve` serves the wiki locally.
- `wikify health` checks wiki pages, links, TODOs, gotchas, decisions, and orphan pages.
- `wikify audit` scans `.wiki/*.md` for likely secrets before committing.
- `wikify connect github` imports merged GitHub PRs into a changelog section in `.wiki/prs-and-tickets.md`.
- `wikify update` rebuilds the mirror and runs health; `--pr-history` imports PRs first.

`wikify build` regenerates `.wiki/_site/` from `.wiki/*.md`.

`--with-pr-history`, `wikify connect github`, and `wikify update --pr-history` detect the
repository's GitHub `origin`, read auth from `GITHUB_TOKEN`, `GH_TOKEN`, or `gh auth token`,
and write a merged-PR changelog to `.wiki/prs-and-tickets.md`. Raw imported PR JSON is
quarantined under ignored `.wiki/_imported/`.

The contract is simple: Markdown is the agent-readable source, HTML is the human-readable
mirror. They should contain the same pages and links.

## Claude Code Paste Prompt

```text
Install Wikify for this repository and verify it is wired for Claude Code.

Run:
  npx @invariance/wikify init --agent claude --with-pr-history

Then verify:
  test -f .wiki/index.md
  test -f .wiki/wiki.md
  test -f .wiki/agent-protocol.md
  test -f CLAUDE.md
  test -f .claude/skills/wikify/SKILL.md
  test -f .claude/settings.json
  npx @invariance/wikify health

After setup, briefly explain what changed, whether PR history was imported, and the URL or
command I should use to browse the wiki locally.
```
