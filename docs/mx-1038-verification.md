# MX-1038 accounts companion verification

- `npm test`: 333 passed, 0 failed (331 backend/logic tests and 2 quota-card render tests).
- `npm run typecheck`: passed against declarations refreshed from bb 0.43.0.
- `bb plugin build .`: backend and frontend bundles produced.
- Managed install reproduction in an isolated copy: runtime dependencies only with
  `npm install --omit=dev --omit=optional --ignore-scripts`, then `bb plugin build .`;
  server.js/server.meta.json/app.js/app.css/app.meta.json all produced.

Behavior exercised without live auth or plugin installation:

- Real registered `thread.failed` handler: Codex and unknown providers produce no Claude
  reads or recovery tracking; a Claude limit still tracks recovery with auto-switch off.
- Real watch reconciliation: only explicitly Claude threads are inspected/adopted.
- Old misclassified Codex recovery records are purged even without Claude capacity.
- Real SDK notification listener: bounded reads, throttling, scope isolation, and no
  restoration of old data when a provider changes during an in-flight read.
- Real telemetry RPC and CLI: same normalized JSON, separate legacy Claude status.
- Fake executable receives exactly `spawn availability`; valid v1 JSON on exit 2 keeps
  independent fresh Codex telemetry. Concurrent callers share a read; cache hits preserve
  observation time; missing CLI, malformed/oversized output and timeout yield UNKNOWN.
- Main Codex and Spark are separate; credits/tokens never create subscription headroom;
  stale/future/missing/partial/malformed/reset-elapsed data yields UNKNOWN.
- Dashboard/homepage quota card rendering: UNKNOWN has no fabricated 0%; paid credits and
  Spark are separate, and stale quota meters are muted.

Deployment is intentionally pending coordination with dotfiles PR 912. This change does
not install/reload a live plugin, enable Account Pooler, change auth routing, change the
custom Claude primary/Python deadman, or modify shared fallback environments. The legacy
Übersicht widget remains Claude-only. It can adopt the new `accounts telemetry --json`
feed separately; legacy `accounts list --json` and `outage` contracts are unchanged.

## UI simplification follow-up

- `npm test`: 338 passed (334 backend/logic, 4 quota-card rendering).
- Default card renders the email, main subscription usage and reset only. Secondary
  buckets, paid credits, metadata and thread quotas/tokens remain inside closed native
  details, available by mouse or keyboard.
- Missing/invalid identity retains quota and uses an email-unavailable label. A UUID
  stays in `accountId` only, including when an old server's label contains it.
- Optional `codex_account_email` comes from the upstream read-only `account/read` contract;
  SDK thread observations never acquire machine account identity.
