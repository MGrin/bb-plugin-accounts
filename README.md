# bb-plugin-accounts

Claude Max account usage and auto-switching for [bb](https://getbb.app).

Shows what each of your Claude subscriptions has left, and — when a thread actually
hits a rate limit — switches to an account with headroom and continues the interrupted
thread where it stopped.

```sh
bb plugin install git:https://github.com/MGrin/bb-plugin-accounts.git@main
```

## What it does

**Homepage tiles** — 5-hour and 7-day utilization per account, with the active one marked.

**`bb accounts`**

```
bb accounts [list]        per-account 5h/7d utilization
bb accounts switch <slot> switch the live credentials to a slot
bb accounts auto          run one auto-switch evaluation now
bb accounts log           the last switch decision and why
bb accounts place         where should work on a model START? ask BEFORE spawning
bb accounts outage        can this machine serve AT ALL? exit 0 means no
```

**Proactive switching** — a schedule compares the active account against `switchAt` and
moves to the candidate with the lowest `max(5h, 7d)` among accounts whose usage data is
fresh, subject to a cooldown.

**Reactive switching** — this is the useful part. bb emits `thread.failed`; when the
failure is a rate limit the plugin switches accounts and then sweeps every currently-stuck
thread through bb's rate-limit recovery, so long-running work survives a limit instead of
dying at it. It complements bb's builtin `provider-retry` plugin, which *waits* for the
window to reset on the single account bb knows about; this one *moves*.

Note what "when the failure is a rate limit" does **not** mean: reading `thread.failed`'s
`error` string. bb fills that field from `system/error` events only, and every provider
limit is written as `provider/error`, so on a real limit failure it is always `null` —
which silently disabled this entire path from the plugin's first commit until 2026-08-11.
The trigger now also reads the thread's newest `provider/rateLimits/updated` event and
fires on a blocked rate-limit snapshot, so it no longer depends on wording bb never sends.
See `isLimitFailure`. (It read that snapshot from `threads.rateLimitRecovery()` until bb
0.39.0 removed the method — get-bb/bb#1623 — which broke detection for two days.)

**Reconciliation** — the tracked set is fed by `thread.failed`, and a store fed by one
event can be switched off by one upstream change, silently, which is exactly what happened.
So every watch tick also *looks*: any non-archived `error` thread the store doesn't know
about is inspected with the same rate-limit read the trigger uses, and adopted if
it is genuinely limit-failed. Adoption remembers the `updatedAt` it inspected, so a
permanently dead thread costs exactly one inspection ever instead of looping
adopt → exhaust attempts → drop → adopt.

**Recovery sweep** — resumes EVERY currently-stuck limit-failed thread, not just the one
attached to whichever event fired. A thread that hit a limit is tracked; every proactive tick and every
reactive switch then sweeps the tracked set, re-verifying each thread is still `error`
before attempting it, so a thread already fixed elsewhere (bb's own `provider-retry`, a
human) quietly falls out of tracking instead of being retried. The resume itself is an
ordinary follow-up message. bb's `provider-retry` owns the *replay* of the failed request
now and schedules it for the moment the blocked window rolls over — hours away — which is
the wait this sweep exists to skip, since accounts has just moved the machine onto an
account with capacity. A message is also the only thing that ever revived a thread whose
limit arrived as an agent message rather than a failed call. Bounded by
`recoveryCooldownSec`/`recoveryMaxAttempts`/`recoveryGiveUpAfterHours` so a thread that
keeps failing for a non-limit reason is never retried forever.

**Capacity gating** — those bounds measure "this thread looks unrecoverable", which is not
what an outage means. When the machine cannot serve at all the sweep holds: no attempts, and
critically no drops, with the dry time banked in `stalledMs` and excluded from the give-up
clock. Without this, the shipped defaults (5 attempts, 120s apart) dropped every stuck
thread 10 minutes into a dry spell — while the soonest account reset was still 87 minutes
away, so the threads were abandoned long before the capacity they were waiting for
arrived. A stale usage cache counts as capacity available: a broken poller must not be
able to freeze recovery.

**`bb accounts outage` — the away-message question.** Answered by the 2-minute `watch`
tick and left somewhere cheap to read, because when the machine really is dark the thing
that would announce the outage is the thing that cannot run.

An outage means the machine **cannot serve at all** — no free window anywhere *and* no
paid credits behind the walls (mgrin's call, 2026-08-21, MX-218). It used to mean "no free
window", which is a different statement the moment credits are on: the command led with
`ALL ACCOUNTS EXHAUSTED` and exited 0 while the machine billed happily. The headline,
`cannotServe` and the exit code are now emitted from one function over one verdict, so
reading any single one of them is safe.

```
0  cannot serve at all, confirmed over N distinct non-stale polls   <- the only "stop"
1  can serve. INCLUDES paid-only, which runs and BILLS — the headline says so
2  cannot tell: stale poll, an unreadable account, or an outage not yet confirmed
```

"No free window anywhere" did not stop being true or useful, so it kept a field of its
own, `allFreeWindowsSpent`, plus the `free`/`back` lines and the free-window ETA. It was
called `allExhausted` until MX-218 and is **renamed, not redefined** — a consumer still
reading the old key gets `undefined`, which is loud, rather than a boolean that quietly
means something else. Same rename on `bb accounts list --json` under `outage`.

**Model downgrade before account switch** — if the failing model has its own ceiling but
the account's overall window still has room, the thread is continued on a lower-tier
model rather than burning a fresh account.

**Placement** — everything above is *reactive*: it moves a thread after the active account
is nearly spent. Placement is the other half — deciding whether the account is a sane place
to START on, before any tokens are burned. `bb accounts place` answers it for a given model,
using the fitted per-family cost calibration, and a `thread.created` listener asks the same
question for every new Claude thread.

Two things it deliberately does not do, both because of what bb actually exposes:

- **It cannot intercept a spawn.** bb has no pre-spawn hook. `thread.created` fires *after*
  the thread row exists and its handler returns `void`, so nothing a plugin returns can
  rewrite or refuse a spawn; there is also no per-thread account, because one keychain means
  the whole machine bills one slot at a time. So the listener is a check, not a router: it
  moves the *machine* before the new thread's first turn, and it is a race it can lose —
  measured at ~750ms of margin on this machine, which is usually but not always enough. If
  you want a spawn to land somewhere for certain, ask first and spawn second:
  `bb accounts place --model claude-fable-5 --switch && bb thread spawn ...` (exit code `2`
  means no account can hold the work, so a fan-out loop can stop instead of starting work
  that cannot run).
- **It never silently overrides an explicit choice.** If you put the machine on an account
  by hand (`bb accounts switch`, `bb accounts auto`, `bb accounts place --switch`) and it
  turns out to be a bad landing site, placement says so — log plus a notification, naming
  the slot it would have picked — and leaves your choice standing for `placementPinMin`.
  Quietly re-routing would mean you believe you are on the account you picked while every
  token goes somewhere else.

It also only moves work *off a wall*, never merely toward a roomier account: if the active
slot can hold the work, the answer is "stay" even when another slot has ten times the
headroom. Spreading load is already the proactive path's job, and two opinions racing on
every thread creation is worse than one.

**Selection never spends money, and it disagrees with reporting on purpose**
(MX-262, mgrin's call 2026-08-22). Asked whether a credit-bearing account whose windows
are spent should be preferred over a window-exhausted one, he answered yes and corrected
himself inside the same message — the answer is **no**:

> *"The account with billing is an exception — I just needed it one time... in normal
> operation the system must not prioritize the account with money; it should operate as
> usual, and if all accounts exhausted all their limits it should wait for limits to be
> waived. So sorry, my correction, the answer is no — it should not rank this account
> above."*

`pickBest` now returns only slots with a **free window**, so no automatic path can select
paid capacity: not `decideSwitch`, not the reactive rate-limit handler, not
`bb accounts auto`. One gate, because guarding each caller leaves the next one unguarded.
When nothing is free the machine **waits**, and says which slot it declined and how to
take it deliberately.

| Question | Asked by | Answer on a paid-only machine |
|---|---|---|
| What is POSSIBLE? | `capacityVerdict`, `bb accounts outage` | `paid-only` — it can serve, exit `1` |
| What is POLICY? | `pickBest`, `decideSwitch` | select nothing; wait |

That disagreement is correct and must not be reconciled: `outage` reporting a billing
machine as stopped is the bug MX-218 fixed, and selection spending on its own is what
mgrin overruled. **`bb accounts switch <slot>` never goes through `pickBest`** and is
never refused — that is the exception he invokes. The recovery sweeper deliberately
follows REPORTING (`anyAccountHasCapacity` holds only on `none`), because a machine he has
deliberately put on the credit account must keep working.

**Three surfaces, one verdict.** The app panel, `bb accounts outage` and the Übersicht
widget all read the same `capacity` field — `free` / `paid-only` / `none` / `unknown` — off
`capacityOf()`, computed from a single poll. The panel does not re-derive it from `credits`
and the two windows, and that is the point: three surfaces quietly disagreeing about whether
this machine can serve leaves a reader with no way to tell which one is stale. The state
worth having right is **`paid-only`** — every free window spent with usage credits open. It
looks like an outage to anything that only counts windows, and it is not one: the machine
serves, and it BILLS. The panel says so in those words. `unknown` is muted rather than
alarming, the same rule as a null utilization and as `exit 2` on the CLI — a stale poll or an
unreadable account asserts nothing, and must not borrow the urgency of either answer.

## Requirements

This plugin is the brain and the UI; it does **not** manage credentials itself. It needs:

- a JSON usage cache at `~/.config/claude-usage/usage.json` with `polledAt` and an
  `accounts[]` array (`slot`, `email`, `active`, `fiveHour.util`, `sevenDay.util`), and
- a `claude-acct` executable on `~/.local/bin` supporting `claude-acct use <slot>` to
  swap the live credentials.

Both come from the author's dotfiles rather than this repo, so **this plugin will not
work out of the box for you** — you need a poller and a credential switcher that produce
that contract. Issues and PRs generalizing this are welcome.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `autoSwitch` | `true` | master switch for every path, placement included |
| `switchAt` | `97` | 5h utilization % that triggers a proactive switch |
| `weeklyAt` | `100` | 7d utilization % that triggers a switch, and caps destinations |
| `placeOnSpawn` | `true` | check a new thread's account has room for its model before it starts |
| `placementMinUnits` | `20` | thousand weighted tokens a new thread must fit before its account counts as usable |
| `placementPinMin` | `60` | minutes a manually chosen account is left alone by placement |
| `downgradeModel` | `claude-opus-5[1m]` | model to continue on when only the top model's ceiling was hit |
| `cooldownSec` | `120` | minimum seconds between switches |
| `staleAfterMin` | `15` | usage data older than this is ignored |
| `recoveryCooldownSec` | `120` | minimum seconds between resume attempts on the same stuck thread |
| `recoveryMaxAttempts` | `5` | give up resuming a thread after this many failed attempts (`0` = unlimited) |
| `recoveryGiveUpAfterHours` | `6` | give up resuming a thread this long after it first got stuck (`0` = never) |

## A note on multiple accounts

This routes your work across subscriptions **you own and pay for**. It is not a way to
exceed a plan's limits, and it does not proxy, pool, share or resell credentials — model
requests are made by bb spawning the normal `claude` binary with the normal credential in
your OS keychain. Sharing credentials and relaying requests on behalf of other users
*are* prohibited by Anthropic's terms; this does neither.

Note also that the usage endpoint it reads is undocumented and unsupported, and per-model
buckets can be absent, so reported utilization may understate real exhaustion. Poll
conservatively. Use at your own risk.

## License

MIT
