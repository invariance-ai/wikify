---
title: wikify Wiki
description: A living in-repo wiki for humans and coding agents.
section: Navigation
order: 1
nav_label: Main page
---

# wikify Wiki

This wiki is the durable memory for this repository. The Markdown files under `.wiki/` are the source of truth for agents. The HTML files under `.wiki/_site/` are the human-readable mirror.

## Start here

- [[wiki]] — preferences for creating and adding to this wiki
- [[architecture]]
- [[decisions]]
- [[todos]]
- [[gotchas]]
- [[prs-and-tickets]]
- [[agent-protocol]]

Initialized without PR history.

## Mirror rule

When a wiki Markdown page changes, run `wikify build` to regenerate `.wiki/_site/`.
