# Wikify

Give your repo a memory.

`@invariance/wikify` installs a living `.wiki/` folder plus agent-native instructions for
Claude Code, Codex, Cursor, OpenCode, and shell-based agents.

On init, Wikify creates both sides of the wiki:

- `.wiki/*.md` — source-of-truth Markdown for agents and git review
- `.wiki/_site/*.html` — generated human-readable HTML mirror for local or hosted browsing

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
npx @invariance/wikify health
wikify serve
```

`wikify build` regenerates `.wiki/_site/` from `.wiki/*.md`.

The contract is simple: Markdown is the agent-readable source, HTML is the human-readable
mirror. They should contain the same pages and links.

## Claude Code Paste Prompt

```text
Install Wikify for this repository and verify it is wired for Claude Code.

Run:
  npx @invariance/wikify init --agent claude --with-pr-history

Then verify:
  test -f .wiki/index.md
  test -f .wiki/agent-protocol.md
  test -f CLAUDE.md
  test -f .claude/skills/wikify/SKILL.md
  test -f .claude/settings.json
  npx @invariance/wikify health

After setup, briefly explain what changed, whether PR history was imported, and the URL or
command I should use to browse the wiki locally.
```
