---
name: accounts
description: Read custom Claude and Codex subscription telemetry, or inspect Claude account switching in the accounts plugin.
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
- The source invokes only `mx spawn availability`, bounded to 10 seconds, 256 KiB and
  at most once per minute across callers. It performs no inference or auth mutation.

The legacy `bb accounts list`, `outage`, `place`, `auto`, `switch`, `log`, `stats` and
`forecast` commands remain Claude-only. In particular, `outage` includes Claude paid
credits by design; it is not the new subscription-only capacity field.

`bb accounts switch <slot>` deliberately changes live Claude credentials. Telemetry has
no Codex switch command, routing controls, Pooler integration or credential exports.
