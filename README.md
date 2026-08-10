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
```

**Proactive switching** — a schedule compares the active account against `switchAt` and
moves to the candidate with the lowest `max(5h, 7d)` among accounts whose usage data is
fresh, subject to a cooldown.

**Reactive switching** — this is the useful part. bb emits `thread.failed`; when the
error is a rate limit the plugin switches accounts and then sweeps every currently-stuck
thread through bb's rate-limit recovery, so long-running work survives a limit instead of
dying at it. It complements bb's builtin `provider-retry` plugin, which *waits* for the
window to reset on the single account bb knows about; this one *moves*.

**Recovery sweep** — resumes EVERY currently-stuck limit-failed thread, not just the one
attached to whichever event fired. A thread that hit a limit is tracked (there is no
server-side way to ask bb for "every errored thread"); every proactive tick and every
reactive switch then sweeps the tracked set, re-verifying each thread is still `error`
before attempting it, so a thread already fixed elsewhere (bb's own `provider-retry`, a
human) quietly falls out of tracking instead of being retried. Bounded by
`recoveryCooldownSec`/`recoveryMaxAttempts`/`recoveryGiveUpAfterHours` so a thread that
keeps failing for a non-limit reason is never retried forever.

**Capacity gating** — those bounds measure "this thread looks unrecoverable", which is not
what an outage means. When EVERY account is walled the sweep holds: no attempts, and
critically no drops, with the dry time banked in `stalledMs` and excluded from the give-up
clock. Without this, the shipped defaults (5 attempts, 120s apart) dropped every stuck
thread 10 minutes into a dry spell — while the soonest account reset was still 87 minutes
away, so the threads were abandoned long before the capacity they were waiting for
arrived. A stale usage cache counts as capacity available: a broken poller must not be
able to freeze recovery.

**Model downgrade before account switch** — if the failing model has its own ceiling but
the account's overall window still has room, the thread is continued on a lower-tier
model rather than burning a fresh account.

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
| `autoSwitch` | `true` | master switch for both paths |
| `switchAt` | `97` | 5h utilization % that triggers a proactive switch |
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
