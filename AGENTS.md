<!-- agents-md ceiling: 75 lines -->
# AGENTS.md — bb-plugin-accounts

Claude Max account usage, placement and auto-switching for bb.
[`README.md`](README.md) is the user-facing document and it is where the *arguments* live
— why selection never spends money, why `outage` and `pickBest` disagree on purpose, why
`thread.created` is a check and not a router. **Read it before changing a decision**; most
of what looks like an inconsistency here is a ruling, cited and dated.

## Commands, all run 2026-09-09

```sh
npm install          # or: npm ci --cache "$PWD/.npmcache"  (see below)
npm test             # node --test over lib.test.ts analytics/*.test.ts app/*.test.ts — 294 tests, 0 fail
npm run typecheck    # tsc --noEmit, rc=0
```

The gate is those two plus `.github/workflows/test.yml` and
`.github/workflows/managed-install.yml`. The last reproduces bb's managed git install —
runtime dependencies only, then `bb plugin build` — so a module imported at runtime but
parked in `devDependencies` builds here and fails for every real user. `better-sqlite3`
and `hono` are types-only and must stay in `devDependencies`.

**`--cache "$PWD/.npmcache"` is load-bearing inside an agent sandbox.** A plain
`npm install` there fails with "Your cache folder contains root-owned files" and prescribes
`sudo chown`; that message is false — it is a read denial wearing an ownership error, and
the remedy it prints is one an agent cannot run. `.bb-env-setup.sh` uses the in-workspace
cache for the same reason, and must never exit non-zero: bb deletes a new worktree whose
setup script fails.

## This plugin does not own its inputs

It is the brain and the UI. It needs a usage cache at
`~/.config/claude-usage/usage.json` and a `claude-acct` executable that can swap live
credentials — **both produced by mgrin's dotfiles, not by this repo**. A change to that
contract lands in two repos or it lands broken. There is no per-thread account: one
keychain means the machine bills one slot at a time, which is why placement moves the
*machine* and can lose the race (~750ms of margin, measured).

## Layout

| path | what it is |
|---|---|
| `lib.ts` | switching, placement, capacity, the verdict functions (`capacityOf`, `pickBest`, `decideSwitch`, `isLimitFailure`) |
| `analytics/` | ingest, calibration, forecasting, the store — one file per concern, each with its test |
| `app/`, `app.tsx`, `components/` | the panel and the homepage tiles |
| `server.ts` | bb wiring: schedules, `thread.failed` / `thread.created` listeners, `bb accounts` |
| `docs/superpowers/{plans,specs}/` | the design documents behind the analytics and the switcher |

## Conventions that differ from the defaults

- **One verdict, one function, many surfaces.** The panel, `bb accounts outage` and the
  Übersicht widget all read `capacityOf()`. Do not re-derive capacity anywhere — three
  surfaces quietly disagreeing leaves a reader no way to tell which is stale.
- **Selection must not be able to spend money.** `pickBest` returns only slots with a free
  window; every automatic path goes through it. Gate the choice once, not per caller.
  `bb accounts switch <slot>` bypasses it deliberately and is never refused.
- **`unknown` is muted, never alarming.** A stale poll or an unreadable account asserts
  nothing and must not borrow the urgency of either answer. Same rule for a null
  utilization and for `exit 2`.
- **A rename beats a redefinition.** `allExhausted` became `allFreeWindowsSpent` so an old
  consumer gets `undefined` — loud — rather than a boolean that quietly means something
  else.
- **Do not read `thread.failed.error` to detect a rate limit.** bb fills that field from
  `system/error` events only and every provider limit is `provider/error`, so it is always
  `null` on a real limit — which silently disabled the whole reactive path until
  2026-08-11. Read the newest `provider/rateLimits/updated` event instead.
- **A store fed by one event can be switched off by one upstream change, silently.** That
  is why every watch tick also *looks* for unknown limit-failed threads and adopts them.

**Nothing about who may merge, how agents are spawned, or how the maintainer's
machine handles secrets belongs in this file, and none of it is stated here.**
Those are properties of a working environment, not of this project; if you are
contributing, your own conventions apply and nothing in this repo depends on
the maintainer's.
