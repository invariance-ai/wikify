---
title: Decisions
description: Durable decisions and rejected alternatives.
section: Project
order: 2
---

# Decisions

Newest first.

## Test management lives in the wiki

**Decision.** The wiki is the system of record for tests. `wikify test` runs the
suite and writes the numbers into [[tests]] mechanically; CI runs
`wikify test --check` and fails any PR whose committed numbers drift from a real
run. The coverage map in [[tests]] is hand-maintained prose; the Stats block is
machine-written and must never be edited by hand.

**Why.** Numbers that humans (or agents) update by hand drift and get gamed.
Generating them from the run and gating on `--check` makes the ledger
trustworthy, and keeping it in `.wiki/` means it's both human- and agent-readable
alongside the rest of the repo memory. See [[tests]] and [[agent-protocol]].

**Rejected.** A coverage badge from an external service (opaque, not in-repo) and
a hand-edited stats table (drifts immediately).

## Dogfooding: Wikify keeps its own wiki

**Decision.** This repository runs Wikify on itself — `.wiki/*.md` is committed,
`.wiki/_site/` is gitignored. Initialised with `--no-agents` so it scaffolds the
wiki without installing agent wiring into this repo.

**Why.** The fastest way to find rough edges is to use the tool on the tool.

## Initial wiki setup

**Decision.** Keep agent-readable Markdown and human-readable HTML as mirrors.

**Why.** Agents need cheap text context in `.wiki/*.md`; humans need a browsable site in `.wiki/_site/`.
