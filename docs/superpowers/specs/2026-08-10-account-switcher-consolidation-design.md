# bb is the sole switch brain

**Date:** 2026-08-10
**Status:** approved, ready for implementation

## Why

Two independent switchers drive one Keychain.

The Python poller (`~/.local/bin/claude_accounts.py`, `claude.usage-poll` LaunchAgent,
180s) polls Anthropic, writes `~/.config/claude-usage/usage.json`, and then calls its own
`decide_switch()` with its own cooldown in `state.json`. The bb plugin reads that same
cache and runs its own `decideSwitch()` on a 2-minute cron, plus a reactive
`thread.failed` handler. Neither knows the other's cooldown. `server.ts` already carries a
comment describing the resulting race and works around it by skipping a tick when the
cache's `active` flag disagrees with the Keychain.

Consolidating is not merely tidiness. On 2026-08-10 six threads sat stopped for hours, and
the diagnosis was slowed by having to establish which of the two brains was supposed to
have acted.

## What each side actually holds

The overlap is narrower than "two things doing the same job". Each brain holds lessons the
other does not, and each holds a capability the other cannot have.

| | Python `decide_switch` | bb `decideSwitch` |
|---|---|---|
| burst trip (5h) | yes, 97 | yes, `switchAt` 97 |
| weekly trip (7d >= 95) | yes | **no** — only via spread |
| velocity trip (projects one poll ahead) | yes | **no** |
| model-family thresholds | yes | no |
| spread / anti-stranding | no | yes |
| reacts to `thread.failed` | **cannot** — no view of bb threads | yes |
| owns polling, OAuth refresh, Keychain swap | **only implementation** | shells out to it |

So the naive consolidation — delete the Python brain, keep bb's — is a regression. It
would discard the weekly and velocity trips, which is precisely what broke on 2026-07-31
and 2026-08-09.

## Decision

**bb becomes the sole brain. Python becomes mechanism only.**

bb is the only side that can observe `thread.failed`, which is ground truth that no
utilization threshold can match: a real limit error is not a prediction. `lib.ts` already
exists to make unattended judgement testable, and the surfaces in daily use (`bb
accounts`, the Übersicht widget) are bb's.

Python keeps polling, refreshing OAuth with backoff, writing the cache, and swapping the
Keychain on command. It stops deciding.

**Strict now, deadman later.** A fallback for "bb is down" is deferred to a follow-up (see
Follow-up). This first change ships without one.

## Architecture

```
Anthropic usage API
        |
        v
  claude_accounts.poll_all()      <-- mechanism: OAuth refresh + backoff
        |
        v
  ~/.config/claude-usage/usage.json
        |
        v
  bb-plugin-accounts server.ts    <-- BRAIN: the only decider
    - 2-min cron          --> decideSwitch(accounts, policy, sinceLastSwitch, prev)
    - thread.failed       --> isLimitError() --> switch + auto-continue
        |
        v
  claude-acct use <slot>          <-- mechanism: Keychain swap
```

`run_poll()` already gates on `auto_enabled()`, which is the presence of
`~/.config/claude-usage/auto.flag`. Demotion is therefore `claude-acct auto off` — one
command, no code deletion, instantly reversible. `decide_switch()` stays in the file,
unreachable, so the follow-up deadman has something to call.

## What ports into lib.ts

### 1. Weekly trip

`decideSwitch` currently reads `activeFive` alone for the urgent path (`lib.ts:80`). An
account at 7d 99% / 5h 10% can only move via *spread*, which requires a 25-point gap and
the 1800s cooldown. That is the 2026-07-31 failure — observed at 7d 100% / 5h 13% with two
idle accounts at 33% and 15% weekly — and it is still live in bb.

`sevenDay >= policy.weeklyAt` (default 95) fires **urgent**, not spread. The weekly
threshold is deliberately lower than the 5h one: a 5-hour window can be waited out, a
weekly window resets on a calendar date.

### 2. Velocity trip

A static threshold assumes the next sample arrives in time. On 2026-08-09 the active
account read 90% and was walled before the next 180s poll. Project forward instead:
measure points-per-second since the previous sample and trip if the next poll would land
at or past `switchAt`.

`decideSwitch` is pure and cannot hold state, so the prior reading arrives as a parameter:

```ts
prev?: { slot: string; fiveHour: number; polledAt: number }
```

`server.ts` persists the last sample in `bb.storage.kv` on each tick.

**`prev.slot` is load-bearing.** A switch resets the series — two different accounts'
readings are not comparable, and treating them as one produces a garbage rate. Python
guards this by only setting `_prev_five_hour` when `now_active.slot == prev_slot`; the port
must do the same, and a test must cover it.

Velocity needs two samples. A single reading has no rate and falls through to the static
tests.

### 3. Candidate headroom

`pickBest` filters candidates at `(a.sevenDay ?? 0) < 100`. Python caps at
`weekly_max=95`. At the current `< 100`, bb will switch into an account at 99% weekly,
which trips again on the next tick. Tighten to `< policy.weeklyAt`.

### Deliberately NOT ported: model-family thresholds

`SWITCH_AT: 97`, `FABLE_SWITCH_AT: 97`, and bb's `switchAt` default `97` are the same
number. The Fable-specific threshold is dead configuration today, and porting it would
port a branch that cannot be exercised.

This is not a claim that Fable never needs its own ceiling — the plugin's reactive path
already handles the genuinely Fable-specific case by downgrading the model rather than
burning an account. It is a claim that a second *threshold* is not how that would be
expressed. If the two numbers ever diverge in `config.json`, revisit.

## New behaviour: alarm when stuck with no candidate

On 2026-08-10 the Python switcher logged `no candidate with headroom` every 180s for
hours and told nobody. Every account was spent; no regex fix and no ported trip would have
helped, because there was nowhere to go. The missing piece was not a decision — it was a
*notification*.

When `decideSwitch` returns `none` **because no eligible destination exists** while the
active account is over a trip threshold, `server.ts` raises a `bb attention`
notification. Distinguish this from an ordinary quiet `none` (nothing is wrong, nothing
trips) — only the wants-to-move-but-cannot case is an alarm.

Rate-limit it to once per trip episode, not once per tick, or a spent fleet produces an
alarm every two minutes all night.

## Error handling

- **Stale cache.** Unchanged: `server.ts` treats data older than `staleAfterMin` (15) as
  stale and does not call `decideSwitch`. With Python demoted the cache is still written
  every 180s, so staleness now means the poller itself is broken — which the widget also
  surfaces.
- **Keychain disagreement.** `activeSlotIsTrustworthy()` compares `claude-acct current`
  against the cache before acting. With one brain the race it guards is gone, but the
  check is cheap and also catches a manual `claude-acct use`. Keep it.
- **No candidate.** See above — now an alarm rather than silence.

## Testing

`lib.test.ts` follows an established convention: cases are named for the incidents that
produced them. New cases:

1. **the 2026-07-31 weekly stranding** — active 7d 100% / 5h 13%, two idle candidates.
   Expect `urgent`, not `none` and not `spread`.
2. **the 2026-08-09 velocity wall** — active at 90% with a prior sample showing a fast
   burn. Expect `urgent` on projection, below the static threshold.
3. **velocity series resets across a switch** — `prev.slot` differs from the active slot.
   Expect the rate to be ignored, falling through to static tests.
4. **a single sample has no velocity** — `prev` undefined. No trip.
5. **will not select a 99%-weekly candidate** — negative case for the tightened filter.
6. **a falling burn rate does not trip** — negative velocity must not project upward.

The existing 13 tests must stay green; none of their policies set `weeklyAt`, so it needs
a default that preserves current behaviour in those fixtures.

## Rollout

1. Port + tests, merged to `main`, plugin reloaded.
2. `claude-acct auto off`; record in dotfiles so a rebuild does not silently re-arm the
   second brain.
3. Observe for a week.
4. Follow-up PR: the deadman.

## Follow-up: the deadman (not in this change)

The Keychain swap affects every Claude client on the machine, not just bb threads —
terminal `claude` and warp included. With bb as sole brain, a silent plugin failure means
nothing switches anywhere.

Planned shape: bb writes a heartbeat timestamp each cron tick; Python switches only if the
heartbeat is older than N minutes **and** the active account is genuinely walled, logging
`deadman`. Strictly ordered, never concurrent, so the Keychain race does not return.

Deferred deliberately — the bb brain should prove itself first, and today's change is
reversible with one command if it does not.
