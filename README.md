# bb-plugin-accounts

Claude Max account switching and Claude/Codex subscription telemetry for [bb](https://getbb.app).

Shows what each of your Claude subscriptions has left, and — when a thread actually
hits a rate limit — switches to an account with headroom and continues the interrupted
thread where it stopped.

```sh
bb plugin install git:https://github.com/MGrin/bb-plugin-accounts.git@main
```

## What it does

**Homepage tiles and dashboard** — Claude account windows plus a separate Codex subscription card, with Spark and paid credits identified separately.

**`bb accounts`**

```
bb accounts telemetry     provider-scoped subscription windows (--json supported)
bb accounts [list]        Claude per-account 5h/7d utilization
bb accounts switch <slot> switch the live credentials to a slot
bb accounts pause <slot>  stop ALL requests on an account; it stays listed, marked PAUSED
bb accounts resume <slot> take it back
bb accounts auto          run one auto-switch evaluation now
bb accounts log           the last switch decision and why
bb accounts place         where should work on a model START? ask BEFORE spawning
bb accounts outage        can this machine serve AT ALL? exit 0 means no
```

**Proactive switching** — a schedule compares the active account against `switchAt` and
moves to the candidate with the lowest `max(5h, 7d)` among accounts whose usage data is
fresh, subject to a cooldown.

**Reactive switching (Claude only)** — this is the useful part. bb emits `thread.failed`; when the
failure is a Claude rate limit the plugin switches accounts and then sweeps every currently-stuck
thread through bb's rate-limit recovery, so long-running work survives a limit instead of
dying at it. It complements bb's builtin `provider-retry` plugin, which *waits* for the
window to reset on the single account bb knows about; this one *moves*.

**Failure detection and reconciliation** — provider errors can arrive with a null
`thread.failed.error`. The plugin reads a bounded newest-first page of provider/system
errors and rate-limit observations, prioritizing the current error over older blocked
quota. OAuth failures are tracked for recovery without entering the model-downgrade
path. Every watch tick also adopts untracked failed Claude threads. Concurrent events
serialize updates to the tracked set so one failure cannot erase another.

**Recovery sweep** — rechecks that each tracked thread remains failed on Claude and
that the actual active account has fresh usable capacity. It sends an existing queued
retry when present, otherwise calls `threads.retry` to replay the failed turn. It never
adds a fabricated continuation request; BB admission controls still apply, and a queued
result is not reported as resumed. Existing unrelated queued messages remain intact.

**Capacity gating** — missing, stale or unreadable active credentials/capacity hold
recovery. The give-up clock excludes that wait. Attempts remain bounded by
`recoveryCooldownSec`, `recoveryMaxAttempts` and `recoveryGiveUpAfterHours`. Capacity on
an inactive slot alone cannot authorize a retry. Paid accounts are never auto-selected.
The legacy list reports UNKNOWN and the diagnostic for failed polls instead of 0%.

**Credential coordination** — automatic switches use
`claude-acct use <slot> --expected-current <observed-slot>` and reject stale plans.
Concurrent plugin switch attempts are coalesced. Requires the MX-1217 dotfiles helper,
which serializes with Claude's native refresh lock and preserves rotated live tokens.
Deploy the helper before reloading this plugin.

**`bb accounts outage` — the Claude away-message question.** Answered by the 2-minute `watch`
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

## Pausing an account (MX-1527)

*"Pause an account. It must be still shown everywhere, not hidden, but marked as paused."*
(mgrin, 2026-10-21.) **Paused means no request of any kind on that account** — the dotfiles
poller stops polling it and neither this plugin nor `claude-acct use` / `codex-acct use` will
switch or place work onto it. It is **not disabled**: resuming is one command.

```
bb accounts pause <slot>          bb accounts codex pause <slot>
bb accounts resume <slot>         bb accounts codex resume <slot>
```

The pause and resume RPCs behind the panel's **Pause / Resume** button run the same functions.
The **active** account cannot be paused — switch away first; the dotfiles CLI refuses it
(rc 2) and the plugin surfaces its reason verbatim. **Pausing and resuming are mgrin's acts**:
nothing in this plugin pauses or resumes on its own, and agents never do either.

A paused account is shown on every surface, never hidden and never an alarm:

- `bb accounts list` — `PAUSED since <time> — no requests (last read 5h 41% 7d 22%, 3h05m ago)`,
  or `last read UNKNOWN`; `--json` carries `paused` and `lastRead`. The panel and homepage card
  show a muted PAUSED badge with the last-known usage dimmed and its age.
- `bb accounts telemetry` — `paused: {at}`, reason `Paused since <ISO> — no requests made`,
  `capacity` stays `unknown` (no new enum value: the widget feed validates it) and prints
  `PAUSED` in place of `subscription UNKNOWN`. Claude's last read is shown as last-known, never fresh.
- **Decisions ignore it.** `pickBest`, `decideSwitch`, placement, `chooseCodexSlot`, the
  forecast and the outage predicate run over accounts in service. A paused account is not
  capacity and — the part that is easy to get wrong — not a blind spot either: a fleet that is
  walled apart from a paused slot is still `none`, not `unknown`; a fleet with every account
  paused is `unknown` and is not an outage. No sample is recorded for it, so a pause leaves no
  run of null readings in the history.
- `bb accounts switch <paused>` and `bb accounts codex use <paused>` are refused here, before the
  helper is called, with the message naming `bb accounts resume <slot>`.

The cache contract (dotfiles): a paused Claude row is `{slot, email, active, paused: {at}}` with
no `error`, no `authState` and no top-level windows, plus `lastGood` — which rate-limited rows
already carry — as the last read; a paused Codex row carries `paused: {at}` and the PREVIOUS
`snapshot`/`observedAt`.

## Provider-scoped telemetry (MX-1038)

`bb accounts telemetry --json` and the `telemetry` RPC return version 1 with normalized
`accounts[]` and separate `tokens[]`. Each observation names its provider, scope, source,
observation time, freshness, account ID (or null), windows and subscription capacity.
`available` / `exhausted` / `unavailable` / `unknown` describes subscription capacity;
paid credits never turn an exhausted subscription into an available one. The legacy
`list`, `outage`, `place`, `switch`, `stats` and `forecast` commands remain **Claude-only** with
their existing meanings and JSON shapes. A telemetry command exits 0 on a successful
report, including UNKNOWN; it is not an admission gate.

Codex snapshots are collected by the dotfiles slot poller through `mx spawn availability`
in isolated native credential homes. The plugin reads its private cache, bounded to
256 KiB, and checks identity and freshness on every read. Missing main buckets, partial
windows, stale/future timestamps and elapsed resets produce UNKNOWN. The observation
expires after 180 seconds; reset passage cannot prove that quota returned.

The v1 contract reads `codex_usage.rateLimitsByLimitId.codex`, falling back to
`codex_usage.rateLimits` only when its own `limitId` is `codex`. Primary/secondary windows
carry `usedPercent`, `resetsAt` in Unix seconds and optional `windowDurationMins`. An
explicit null window is allowed, but at least one valid window is required. Spark never
substitutes for the main bucket. `planType` and `credits` describe the main bucket separately.
`codex_observed_at` is the Codex observation time, with the older conservative
`observed_at` as a compatibility fallback. `codex_account_id` is an optional opaque internal ID. The additive `codex_account_email`
comes from read-only `account/read` with `refreshToken: false` in the same app-server
session; identity lookup failure does not invalidate quota. The normalized `email` and
`label` fields provide a human-readable feed for BB and desktop consumers. Without a
valid email the label says "Codex account (email unavailable)"; a UUID is never a display
label. SDK thread observations never inherit this machine account's email.

The homepage and dashboard show only email, main subscription usage and reset time by
default. A closed **Details** section contains secondary buckets, credits, plan/source
metadata, and (on the dashboard) thread quotas and token counts.

BB's `experimental_thread.events` notifications trigger bounded reads of the newest
`provider/rateLimits/updated` and `thread/tokenUsage/updated` SDK events (100 events,
30-second minimum per thread, four concurrent reads, 64 retained threads). SDK quota
observations lack account identity and complete numerical main-bucket windows, so they
remain thread-scoped UNKNOWN capacity. They show the provider's reported window status
without inventing percentages. Token totals require a matching provider session with
explicit Codex attribution in the same page; they are never converted to quota or merged
into Claude analytics. Reads do not refresh an event's observation time.

All failure detection, reconciliation, placement and recovery paths require exactly
`claude-code` before acting on Claude accounts. Old misclassified Codex recovery records
are removed by the sweeper, and provider identity is checked again before a resume.
Codex switching has its own opt-in watch decision and credential helper, described below.
Claude recovery and the separate Python deadman retain their existing behavior.

The SDK event notification requires bb 0.43 or newer. Verification includes the actual
plugin failure handler, reconciliation, event listener, RPC and CLI under the public SDK
fake host, fake `mx` process tests, and rendering the quota cards. Live install/reload is a
separate coordinated deployment step.

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
| `autoSwitch` | `true` | Claude master switch, placement included |
| `codexAutoSwitch` | `false` | Codex watch decisions; enable after real session verification |
| `codexSwitchAt` | `97` | Codex main window threshold %, with a 120-second switch cooldown |
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

## Codex account slots and analytics (MX-1328)

The dotfiles `codex-acct` helper owns macOS Keychain slots and the live native Codex
login. Capture the current login with `codex-acct capture <name>`, sign in to the
second account through the official flow, then capture that slot too. The usage-only
`codex.usage-poll` LaunchAgent writes `~/.config/codex-usage/usage.json` every 180 seconds.
Both BB surfaces and Übersicht display each captured account and its active-login marker.
The marker describes the file used by new processes; existing sessions may retain an
older account. Automatic mode ships **off** pending a two-account running-session exercise.

- `bb accounts codex use <slot>`: manual switch, expected-current identity checked;
  a spent or unknown target reports a potential paid-credit warning.
- `bb accounts codex auto`: one decision using `codexAutoSwitch` and `codexSwitchAt`.
  Chooses only fresh, lower-use main subscription capacity; the credential helper checks
  free capacity again inside the transaction. No Spark/credits selection or token-based quota.
- `bb accounts telemetry --json`: unchanged v1 envelope, multiple Codex rows with additive
  `slot` and `active` fields. Missing/malformed cache gives UNKNOWN, not a fabricated zero.

The usage dashboard indexes structured native Codex session records every 15 minutes
(`bb accounts reindex` triggers the existing indexer). `turn_context` supplies
model and cwd; `token_usage_record.usage` supplies per-response tokens. Global response
IDs dedupe replay/forks; cumulative turn/thread blocks are ignored. Cwd goes through the
existing repo resolver. Unattributed records remain visible as unknown/unresolved.
Input includes cached input and output includes reasoning, so these components are
shown separately without being added twice. These are local indexed responses only,
not a complete account-wide usage meter. Claude weighted-token views remain separate.

The forecast overlays Codex window percentages on a shared time axis with Claude's
summed headroom points, using distinct labeled scales. Codex uses only its own quota
samples: at least three days and 1,440 fresh polls, including 1,296 valid adjacent
intervals (at most ten minutes apart, same reset, no utilization decrease). Thin history
is provisional; stale history has no projection. Each line follows observed average
burn and ends at its window reset; it does not predict refills or infer quota from tokens.

Forecast provider identities remain visible when data is stale or unavailable (UNKNOWN).
Failed refreshes retain the last series roster without projecting old measurements.
Opening the panel records current Codex windows independently of the history schedule.

The usage page's 7d/14d/30d **History range** controls retrospective breakdowns.
The forecast independently covers the next 14 days, as returned by the handler;
Claude includes the horizon endpoint while each Codex line still ends at reset.
Claude's left scale auto-fits the projected headroom, not the subscription maximum.
Each account contributes the smaller of its remaining 5h and weekly policy headroom
(up to 97 points with the default switch threshold, hence 194 for two fresh accounts).

Last-switch display and `bb accounts log` also reconcile active-login transitions
from usage polls, covering `claude-acct use` and native login changes which do not
write plugin KV. These are labeled observations with the first poll time: the exact
switch time and source are unknown. A matching plugin switch retains its exact
record. Observations do not change switching cooldown or manual placement pins.
