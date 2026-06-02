#!/usr/bin/env sh
set -eu

PACKAGE="${WIKIFY_PACKAGE:-@invariance/wikify}"
AGENTS="${WIKIFY_AGENTS:-claude,codex,cursor,opencode}"
PR_HISTORY="${WIKIFY_PR_HISTORY:-with}"
ROOT="${WIKIFY_ROOT:-$(pwd)}"

case "$PR_HISTORY" in
  with|true|1|yes)
    PR_FLAG="--with-pr-history"
    ;;
  without|false|0|no|none)
    PR_FLAG="--no-pr-history"
    ;;
  *)
    echo "WIKIFY_PR_HISTORY must be one of: with, without" >&2
    exit 1
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "Wikify requires Node.js 18+." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Wikify requires npm." >&2
  exit 1
fi

echo "Installing Wikify in $ROOT"
echo "Package: $PACKAGE"
echo "Agents: $AGENTS"
echo "PR history: $PR_HISTORY"

npx -y "$PACKAGE" init --root "$ROOT" --agents "$AGENTS" "$PR_FLAG"
npx -y "$PACKAGE" health --root "$ROOT"

cat <<EOF

Wikify initialized.

Next:
  npx -y $PACKAGE serve --root "$ROOT"

HTML:
  $ROOT/.wiki/_site/index.html

Markdown:
  $ROOT/.wiki/index.md

Agent start:
  read .wiki/index.md
EOF
