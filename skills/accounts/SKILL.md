---
name: accounts
description: Read custom Claude and Codex subscription telemetry, switch captured Claude/Codex accounts, or see which accounts mgrin has paused in the accounts plugin.
---

# Custom subscription accounts

`bb accounts telemetry [--json]` returns normalized provider observations. Version 1 has
`accounts[]` and separate thread `tokens[]`. Read `providerId`, `scope`, `observedAt`,
`fresh` and `capacity` together. A successful read exits 0 even when capacity is UNKNOWN;
this is a reporting command, not an admission gate.

- `capacity` is subscription headroom only: available, exhausted, unavailable or unknown.
  Credits and token counts never make a subscription available.
- Codex's main `codex` bucket controls ordinary capacity. Spark is shown separately.
- Use `email` or `label` for display, never `accountId`. `codex_account_email` comes from
  read-only `account/read` (`refreshToken: false`); missing email stays unavailable and
  does not invalidate quota. The UI defaults to usage/reset, with diagnostics collapsed.
- A Codex local-session observation without `accountId` cannot identify an account. SDK
  quota observations stay thread-scoped and cannot replace the current local snapshot.
- Missing, malformed, stale, future-dated or incomplete main quota is UNKNOWN. A reset
  passing is not evidence of recovery: read a fresh observation.
- Codex account rows read the private `~/.config/codex-usage/usage.json` slot cache (256 KiB max). The dotfiles usage-only poller gathers native app-server quota in isolated credential homes every 180 seconds. Stale rows are UNKNOWN. `slot` and `active` identify the live login on disk, not every running process.

The legacy `bb accounts list`, `outage`, `place`, `auto`, `switch`, `log`, `stats` and
`forecast` commands remain Claude-only. In particular, `outage` includes Claude paid
credits by design; it is not the new subscription-only capacity field.

`bb accounts switch <slot>` changes live Claude credentials.
`bb accounts codex use <slot>` changes the live Codex login through the dotfiles
`codex-acct` helper with expected-current identity protection. Capture logins using
`codex-acct capture <slot>` after an official human sign-in. Never read or print auth blobs.
`bb accounts codex auto` runs one decision; `codexAutoSwitch` defaults off. Enable only
after running-session refresh behavior has been verified. `codexSwitchAt` defaults to
97; candidates require fresh free main windows and the helper rechecks capacity during
switching. Cooldown is 120 seconds. Spark and credits cannot make a candidate eligible.

The usage page includes native Codex response tokens by model/repo/directory. Input
includes cache; output includes reasoning; neither maps to quota percent. Missing turn
context is shown as unknown/unresolved. Codex forecasts use each account/window's own
measured quota history; they remain provisional until three days, 1,440 polls, and 1,296
valid adjacent intervals. Forecasts stop at reset and do not predict post-reset use.

## Paused accounts

`bb accounts pause <slot>` / `bb accounts resume <slot>` (Claude) and
`bb accounts codex pause <slot>` / `bb accounts codex resume <slot>` (Codex) pause or resume
an account. **Paused means no request of any kind is made on it** — it is not polled, nothing
switches or places work onto it, and `switch` / `codex use` refuse it naming `resume`. It stays
listed everywhere, marked PAUSED, with its last-known usage and that reading's age. It is not
disabled: resume is one command. The active account cannot be paused; switch away first.

- In `telemetry --json` a paused row has `paused: {at}`, `capacity` `unknown` and `fresh` false.
  Read `paused` before reading `capacity`: it is a decision, not a fault. Never report a paused
  account as unreadable, blind, lost or as missing capacity, and never raise an alarm about one.
- A paused account's windows are LAST-KNOWN: say how old they are, never present them as current.
- **Pausing and resuming are mgrin's acts: agents never pause or resume an account on their own.**
  Not to save quota, not to dodge a limit, not because an account looks unhealthy. If a pause
  seems wrong, tell mgrin; do not undo it.
