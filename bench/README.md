# Wikify benchmarks

A harness for measuring the test-management + review system. Run all three:

```bash
npm run bench
```

## Dimensions

1. **review-quality** — runs a reviewer over seeded-bug fixtures
   (`fixtures/review.json`) and scores **precision / recall / F1**. A prediction
   counts as a true positive when its category matches and its line is within
   ±2 of the planted issue.

2. **ledger-accuracy** — fully deterministic, no reviewer needed. Drives a
   sequence of simulated PRs through `wikify test` and checks that
   `.wiki/tests.md` always reflects the real run, and that `wikify test --check`
   catches injected drift. Score = step accuracy × drift-detection.

3. **e2e-prs** — the whole pipeline against **real merged PRs** listed in
   `fixtures/prs.json` (empty by default). Fetches each PR's files via `gh`,
   runs the reviewer, and scores against ground-truth findings. Skips cleanly
   when the manifest is empty or `gh` is unavailable.

## Reviewers

`review-quality` and `e2e-prs` need a reviewer. The default is a small set of
regex heuristics (`reviewers/baseline.js`) — it exists only to make the harness
runnable and to set a floor. The real target is the **`wiki-review` skill** (an
agent/LLM). To benchmark a different reviewer, add a module that exports
`{ name, review({ file, code }) -> findings }` and select it:

```bash
WIKIFY_REVIEWER=my-reviewer npm run bench
```

A `finding` is `{ file, line, category, message }`, category ∈
`correctness | security | tests | clarity`.

## Extending

- Add seeded-bug cases to `fixtures/review.json` — keep expectations honest.
- Populate `fixtures/prs.json` with real PRs you have ground truth for.
- Wire the `wiki-review` skill (or an Anthropic API call) in as a reviewer to
  measure the real system, not just the baseline floor.
