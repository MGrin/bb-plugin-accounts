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
error is a rate limit the plugin switches accounts and then calls bb's rate-limit
recovery to **continue the failed thread**, so long-running work survives a limit
instead of dying at it. It complements bb's builtin `provider-retry` plugin, which
*waits* for the window to reset on the single account bb knows about; this one *moves*.

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
