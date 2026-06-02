---
title: Wiki preferences
description: Preferences that govern how this wiki is created and extended.
section: Wikify
order: 1
---

# Wiki preferences

Preferences here govern how agents **create** and **add to** this wiki. Read this page before writing any wiki content, and keep it up to date as preferences change.

## Audience

State who reads this wiki so prose is pitched correctly.

- Default audience: mixed (engineers and non-engineers).
- If the primary reader is a **non-developer**, include short **code excerpts with plain-English explanations** rather than bare `file:line` references — lead with the what/why, then the how, and define jargon on first use.

## On wiki creation

- Keep [[index]] as the single entry point; every page links back to it.
- One concept per page; link liberally with `[[wikilinks]]`.
- Markdown under `.wiki/` is the source of truth; run `wikify build` to refresh the HTML mirror.

## On wiki adding

- Add durable knowledge only: decisions, gotchas, architecture, persistent TODOs, PR/ticket context, user corrections.
- Do not store secrets or transient progress.
- Match the **Audience** preference above when writing prose and examples.
- After edits, run `wikify build` and `wikify health`.
