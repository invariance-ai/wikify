---
title: Test ledger
description: Authoritative record of automated tests and their numbers.
section: Wikify
order: 3
---

# Test ledger

This page is the authoritative record of this repository's automated tests. The **Stats** block is written mechanically by `wikify test`; do not hand-edit it — CI fails if the committed numbers drift from a real run.

## Coverage map

Describe what the suite covers, area by area. Hand-maintained; keep it honest.

- **`test/unit.test.js`** — pure helpers in `src/wikify.ts`: argument parsing, page/frontmatter formatting, slugify/escape, the Markdown renderer (headings, code fences, existing vs. missing wikilinks), the managed-block writer (idempotency + code-fence safety), and the secret-audit patterns. Does not exercise the filesystem-heavy commands.
- **`test/integration.test.js`** — drives the real CLI binary end to end against throwaway temp dirs: `init` scaffolding + idempotency, `health` on a fresh wiki, the missing-wiki guidance on `build`, and `audit` flagging a planted secret. Covers exit codes and stdout as a user sees them.
- **`test/ledger.test.js`** — the test-ledger feature itself: TAP summary parsing, test-file counting, and `wikify test` writing parsed numbers into this page's Stats block. Uses an isolated fixture with a stubbed `testCommand`, so it never re-runs the real suite.

Not yet covered: `serve`, `share`, `connect github` (network), and provenance/git-staleness rendering.

## Discipline

Every PR must keep these numbers current: run `wikify test` and commit the updated [[tests]] page. The review skill records tests added / touched per PR alongside the [[prs-and-tickets]] context.

## Stats

<!-- wikify:test-stats:start (managed by `wikify test` — do not edit) -->
Last run: local — **✅ passing**

| Metric | Count |
| --- | --- |
| Total tests | 23 |
| Passing | 23 |
| Failing | 0 |
| Skipped | 0 |
| Todo | 0 |
| Test files | 3 |
<!-- wikify:test-stats:end -->
