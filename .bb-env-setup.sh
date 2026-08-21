#!/usr/bin/env bash
# Runs once in a fresh bb-managed worktree, right after `git worktree add`.
#
# WHY IT EXISTS: a worktree checks out TRACKED FILES ONLY, so node_modules
# arrives empty and bb says nothing about it. The agent standing in that
# worktree then sources a dependency tree by hand from another checkout on this
# disk — and that leaves no diff, no install log and no lockfile change, so the
# suite comes up green against dependencies nobody chose. Measured over 15
# candidate donors in MX-239; 12 held the wrong resolved version.
# See ~/Dev/dotfiles/docs/bb-worktrees.md.
#
# --cache "$PWD/.npmcache" IS LOAD-BEARING. DO NOT DELETE IT AS REDUNDANT.
# Run from inside the agent Bash sandbox, a plain `npm install` fails with
# "Your cache folder contains root-owned files" and prescribes `sudo chown`.
# That message is FALSE — 0 of ~114500 files under ~/.npm are root-owned; it is
# a sandbox read-denial wearing an ownership error, and the remedy it prints is
# one an agent cannot run. A cache inside the workspace is readable in both
# sandbox modes, so this line is also the form to use when re-running by hand.
#
# NEVER FATAL: bb DELETES the new worktree if this script exits non-zero
# (`bb guide environments`), so a failed install must still leave a usable
# environment to debug in.
set -uo pipefail

if ! command -v npm >/dev/null 2>&1; then
  echo "bb-env-setup: npm not found (brew bundle installs node)"
  exit 0
fi

npm ci --cache "$PWD/.npmcache" \
  || npm install --cache "$PWD/.npmcache" \
  || echo "bb-env-setup: install failed — rerun 'npm ci --cache \"\$PWD/.npmcache\"' by hand"

echo "bb-env-setup: bb-plugin-accounts ready — 'npm test' runs tests, 'npm run typecheck' typechecks"
