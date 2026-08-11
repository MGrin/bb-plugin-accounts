# Usage history, analytics, and blackout forecasting

**Date:** 2026-08-11
**Status:** approved, ready for implementation

## Why

The plugin knows what every account has left *right now*. It knows nothing about how any
of them got there.

That gap makes three ordinary questions unanswerable:

- Are three Claude Max subscriptions enough, or is a fourth needed?
- When will all three be walled at once, and for how long?
- Where does the quota actually go — which model tier, which projects, fleets or hand-typed
  work?

Worse, the data needed to answer them is being actively discarded. Every artifact the
system writes today is either a snapshot or a short rolling buffer:

| Source | Content | History retained |
|---|---|---|
| `~/.config/claude-usage/usage.json` | 5h/7d util per account | **none** — overwritten every poll |
| `~/.config/claude-usage/switch.log` | full 3-account util snapshot per decision | **~10h** — trimmed to `DECISION_LOG_KEEP` (200 lines) |
| `~/.config/claude-usage/switches.jsonl` | performed switches only | 7 records total, ever |
| plugin kv `prev-sample` | one prior sample, for the velocity trip | one poll |

Meanwhile Claude Code has been recording per-message token counts, model ids, timestamps,
working directories, and sidechain flags in `~/.claude/projects/**/*.jsonl` since
2026-07-16 — 2,648 files, 548 MB, 26 days deep, untouched by any of this.

So there are two facts to build on: the signal that matters most is not being kept, and a
usable proxy for it already exists retroactively.

## Decision

Record poll-derived utilization as the ground truth going forward; index the transcripts to
get retroactive history; fit a conversion between them so the retroactive history is
calibrated rather than merely suggestive.

**Analytics is strictly observational.** It reads what the switcher sees and never
influences what the switcher does. `decideSwitch` and the recovery sweep are untouched by
this work.

### Why both spines

Neither alone answers the question.

Poll data is exactly what Anthropic counts — the thing that actually walls a thread — and
it covers usage from every client, including the web app and phone. But it starts empty:
three days before 5-hour patterns emerge, roughly two weeks before a weekly forecast means
anything.

Transcript data is 26 days deep tonight and carries attribution that polls structurally
cannot: which project, which model, whether a burn came from the main thread or a fleet
fan-out. But it measures tokens, not Anthropic's opaque limit units, and it is blind to
usage outside Claude Code.

Fitting one to the other converts the transcript archive from an approximation into a
calibrated backfill, and the fit keeps improving as real overlap accumulates.

## Architecture

```
Anthropic usage API
        |
        v
claude_accounts.py (180s LaunchAgent) --> usage.json
                                             |
                          [existing */2 watch tick, after the switch decision]
                                             |
                                             v
~/.claude/projects/**/*.jsonl            usage_sample
        |                                    |
   [15-min indexer]                    burn_interval
        |                                    |
        v                                    v
  transcript_msg  ------ nightly fit ---> model_weight
        |                                    |
        +--------------> demand profile <----+
                                |
                                v
                      capacity simulator
                                |
        +-----------+-----------+-----------+
        v           v           v           v
   nav panel   homepage    bb accounts   Übersicht
    (charts)     line      forecast      widget line
                                |
                                v
                          alert evaluator
```

## A. Data layer

Storage is the plugin's own SQLite, opened with `bb.storage.database()` and migrated with
`bb.storage.migrate()` — `<dataDir>/plugins/accounts/data.db`. Migration statements are
append-only; never reorder or edit a shipped statement.

### Schema

**`usage_sample`** — one row per account per distinct poll.

| Column | Notes |
|---|---|
| `polled_at` | integer epoch seconds, from `usage.json`'s own `polledAt` |
| `slot` | account slot id |
| `five_util`, `five_resets_at` | nullable — the API returns null for an untouched window |
| `seven_util`, `seven_resets_at` | nullable |
| `active` | 0/1, whether this slot held the Keychain at poll time |

Primary key `(polled_at, slot)`. This is the dedupe mechanism: the Python poller runs at
180s and the bb watch tick at 120s, so roughly one tick in three re-reads a `polledAt` it
has already stored. Insert with `INSERT OR IGNORE`.

Volume: 3 slots × ~480 distinct polls/day ≈ 1.4k rows/day, ~500k/year. No retention policy
is needed at this size; adding one would be premature.

**`burn_interval`** — derived consumption events, one row per (slot, window) per interval
between consecutive samples.

| Column | Notes |
|---|---|
| `slot`, `window` | window is `'5h'` or `'7d'` |
| `t0`, `t1` | interval bounds, epoch seconds |
| `delta_util` | `util(t1) - util(t0)`, in percentage points |
| `is_reset` | 1 when the window rolled inside this interval |

Reset detection: utilization within a window is monotonically non-decreasing, so a decrease
means the window rolled. When `util(t1) < util(t0)`, or when `resets_at` changed between
samples, mark `is_reset = 1` and record `delta_util` as the post-reset value only. The
pre-reset remainder is unrecoverable at 1% granularity and is not worth reconstructing.

Derivation runs incrementally on each ingest, from the last stored `t1` forward.

**`transcript_msg`** — one row per assistant message that carries a `usage` block.

| Column | Notes |
|---|---|
| `ts` | message timestamp |
| `session_id` | transcript file uuid |
| `cwd` | working directory recorded in the record |
| `project` | derived from the transcript's parent directory name |
| `model` | model id as reported |
| `is_sidechain` | 0/1, from the record's sidechain flag |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens` | verbatim |

**`model_weight`** — the calibration.

| Column | Notes |
|---|---|
| `model` | model id, or a family bucket when a specific id has too few samples |
| `points_per_1k` | fitted weight, utilization points per 1k weighted tokens |
| `fitted_at` | epoch seconds |
| `sample_count`, `residual` | fit quality, surfaced in the UI as a confidence label |

**`ingest_cursor`** — `(path, size, mtime, byte_offset)`. Makes transcript scanning
incremental: a file whose size and mtime are unchanged is skipped without opening it.

### Poll ingest

Hooks the **existing** `*/2 * * * *` watch schedule in `server.ts`. That handler already
reads `usage.json`; ingest is one additional insert plus the incremental `burn_interval`
derivation.

Two constraints on that placement, both non-negotiable:

1. Ingest runs **after** the switch decision and any resulting switch, never before.
2. Ingest is wrapped in its own `try`/`catch` that logs and swallows. An analytics failure
   must never be able to break the path that keeps stuck threads alive.

The watch handler currently returns early when `autoSwitch` is off, before it reads the
cache at all. Recording must not be conditional on switching being enabled, so the handler
is restructured: read `usage.json` first, run the decision and any switch only when
`autoSwitch` is on, then ingest unconditionally. The early return becomes a guard around the
decision block rather than around the whole handler. Ingest stays in the same schedule — a
second schedule reading the same file would be a new moving part for no gain.

### Transcript ingest

A separate `*/15 * * * *` schedule. For each transcript file whose `(size, mtime)` differs
from its cursor, seek to `byte_offset` and parse forward line by line; append rows; store
the new offset. A file that shrank (rotated or rewritten) is re-read from zero.

The first run backfills all 548 MB. Expect 2-3 minutes; it runs once, off the critical path
of anything. Subsequent ticks read kilobytes.

Parsing is defensive throughout — a malformed line is skipped, not fatal. Transcript format
is undocumented and can change under a Claude Code upgrade.

### Calibration

Only one account holds the Keychain at a time, so token burn during any interval attributes
unambiguously to whichever slot was active then. The active-slot timeline comes from
`usage_sample.active`, with `switches.jsonl` used to seed the period predating this feature.

For each `burn_interval` on the 5h window with `is_reset = 0`, sum the transcript tokens in
`[t0, t1)` grouped by model, and fit:

```
delta_util ≈ Σ_model  w_model × (weighted_tokens_model / 1000)
```

Weighted tokens apply a fixed discount to cache reads, which bill at roughly a tenth of
fresh input. Solve by non-negative least squares; weights cannot be negative.

Cold start: seed `w_model` from published per-model pricing ratios, which give the right
relative ordering even when the absolute scale is wrong. Refit nightly, and again whenever
a new model id first appears. The 200 surviving lines of `switch.log` provide roughly 10
hours of usable overlap to seed from on day one.

Intervals containing a window reset, or spanning a gap longer than 10 minutes in poll
coverage, are excluded from the fit.

## B. Forecast model

Two layers with different horizons, because a single model cannot serve both.

### Layer 1 — velocity (0-2h)

Burn rate from the most recent samples, extrapolated linearly to the wall. This already
exists as the velocity trip in `claude_accounts.py` and in `decideSwitch`'s projection.
Reuse the existing computation; do not build a second one.

### Layer 2 — demand profile (2h-14d)

Aggregate historical burn into `hour_of_day × day_of_week` buckets — 168 buckets — as
utilization points per hour, recency-weighted with an exponential decay of roughly two
weeks so recent behaviour dominates without discarding the older archive. Buckets with too
few observations fall back to the day-of-week mean, then to the global mean.

### Capacity simulator

Steps forward in 15-minute ticks over a 14-day horizon:

1. For each account, track its 5h and 7d windows against their real `resetsAt`, rolling
   each window to zero when its reset time passes and scheduling the next one.
2. Draw the tick's demand from the profile bucket.
3. Spend it on the account the switcher **would** pick — mirroring `nextSlot`: the
   candidate with the lowest `max(5h, 7d)` among accounts with fresh data. This mirroring is
   read-only; the simulator imports the existing pure selection function from `lib.ts`
   rather than reimplementing it, so the two cannot drift.
4. Record aggregate headroom at each tick.

Outputs:

- **First blackout** — the first tick where every account satisfies `5h ≥ switchAt` OR
  `7d ≥ weeklyAt`, using the live configured thresholds rather than hardcoded ones.
- **Blackout duration** — from that tick until the soonest window reset that actually
  restores usable capacity.
- **Weekly exhaustion date** per account.

Run the simulation three times at p10, p50, and p90 demand, taking the percentiles from the
historical distribution within each bucket. Every forecast is reported as a range with a
central estimate: *"dry between 17:20 and 20:10, most likely 18:40."* A single number here
would be false precision, and early on the range will be very wide — which is the honest
answer, not a defect.

### Confidence labelling

Every forecast surface carries a confidence state derived from data coverage:

| State | Condition |
|---|---|
| `provisional` | < 3 days of poll samples — forecast is transcript-calibrated only |
| `fitted` | ≥ 3 days of poll samples, calibration residual within tolerance |
| `stale` | most recent sample older than 30 minutes |

`provisional` is displayed prominently and suppresses alerts entirely.

### The capacity verdict

"Are three accounts enough?" gets a direct answer rather than a chart to interpret:

- **Retrospective** — over the trailing 4 weeks, the fraction of working hours (configurable
  band, default 08:00-22:00 local) during which no account had headroom.
- **Counterfactual** — the same simulation re-run with 2, 3, 4, and 5 slots, plotting
  blackout-hours-per-week against slot count. The marginal value of a fourth subscription
  becomes a number.

The counterfactual assumes an added account is identical in limits to the existing ones and
that demand is unchanged by the extra headroom. Both assumptions are stated in the UI; the
second is the weaker one, since more headroom tends to induce more use.

## C. Surfaces

### Nav panel

Its own route, registered via `app.navPanel`. Responsive, because it must work from a phone
over `https://bb.scani.xyz`; the plugin's existing compact-viewport hooks and coarse-pointer
sizing apply.

Contents:

1. **Capacity timeline** — forward 48h, per-account stacked headroom with the p10-p90 band
   and blackout regions marked.
2. **Hour × weekday heatmap** — burn intensity, 168 cells.
3. **Burn by model tier** — stacked area over time.
4. **Burn by agent shape** — main thread vs. sidechain, the fleet-attribution view.
5. **Project leaderboard** — top projects by burn over a selectable window.
6. **Accounts-needed curve** — the counterfactual described above.

**Charts are hand-rolled SVG. No chart library.** The plugin has no chart dependency today,
and a heatmap, a stacked area, and a banded timeline are simple shapes — roughly 150 lines
of SVG against roughly 100 KB of bundle for Recharts. Revisit only if a genuinely
interactive chart is wanted later.

Per the route-scoped-surface constraint, any client state that must survive navigation goes
to `localStorage`, never a `useRef` — the component unmounts on every route change.

### Homepage tile

One added line to the existing section:

```
all accounts dry ~18:40 (17:20-20:10), back ~21:50
```

Suppressed when no blackout is forecast within the horizon, and replaced with the
provisional label while confidence is `provisional`.

### CLI

| Command | Output |
|---|---|
| `bb accounts stats [--days N]` | burn totals and the four breakdowns |
| `bb accounts forecast` | blackout prediction, weekly exhaustion, confidence |
| `bb accounts history [--slot S] [--days N]` | sample series, terminal sparklines |

All three take `--json`, following the existing `bb accounts list --json` convention.

### Übersicht widget

`dash-claude-usage` already shells out to `bb accounts list --json` with the cache as a
fallback. Extend it to also call `bb accounts forecast --json` and expose the blackout
estimate; render one additional line in `claude-usage.jsx`.

Two existing constraints carry over: the pinned `NODE_PATH` (Übersicht's minimal PATH has no
Homebrew), and the `source` marker distinguishing live bb data from a cache fallback. A
forecast call that fails or times out must degrade to omitting the line, never to blanking
the widget.

This change lands in `~/Dev/dotfiles` as a separate commit.

## D. Alerts

Two classes. Both use the existing `alarmIfCornered` mechanism — `osascript display
notification`, guarded by a kv key so an episode cannot re-ring on every tick.

**Blackout ahead.** Fires when the p50 simulation predicts total blackout within 3 hours.
The kv key is the predicted blackout start bucketed to the hour, so a forecast that drifts
by minutes does not re-alert. Message carries the predicted range, the expected duration,
and the soonest restoring reset.

**Weekly pace.** Fires when the simulation projects all three 7-day windows to exhaust
before their resets. At most once per calendar day.

Both are suppressed:

- between 22:00 and 08:00 local, checked explicitly — note that this path is raw
  `osascript` and does **not** inherit the attention plugin's quiet hours;
- while confidence is `provisional` or `stale`.

### On the standing directive

A standing instruction on file (`mem_mocyjjx90ec`) says never to raise or escalate Claude
usage limits. It exists to stop agents nagging mid-task about quota.

These alerts were explicitly requested and are deliberately scoped not to re-create that.
They are planning information about *aggregate* capacity — never about an individual
account approaching its wall, never tied to a running task, never a prompt to conserve or
reschedule work. If they start reading as nagging, the fix is to cut the weekly-pace class
first; it is the one closer to the line.

## Testing

`lib.ts` is already a pure, unit-tested module (`lib.test.ts`, `node --test`). Everything
with judgement in it goes there and gets tests:

- **Reset detection** — a util decrease, a `resets_at` change, a decrease with no
  `resets_at` change, and a null-to-value transition.
- **Interval derivation** — gaps in poll coverage, duplicate `polledAt`, out-of-order
  samples.
- **Calibration fit** — recovers known weights from synthetic burn; degrades sanely when a
  model has no samples; never returns a negative weight.
- **Demand profile** — sparse buckets fall back correctly; recency weighting behaves at the
  boundaries.
- **Simulator** — window rolls at the right tick; blackout is detected only when every
  account trips; duration ends at the correct restoring reset; slot-count counterfactual is
  monotonic in slots.
- **Alert gating** — one alert per episode across a drifting forecast; quiet hours; the
  provisional suppression.

Transcript parsing gets fixture-based tests over a handful of real records, including a
malformed line.

## Build order

Phase 1 is urgent in a way the rest is not: until it ships, history continues to be lost
permanently. It is independently shippable and retains its value regardless of what happens
to the remaining phases.

| # | Phase | Estimate |
|---|---|---|
| 1 | Migrations, `usage_sample` ingest on the existing watch tick, `burn_interval` derivation | ~3h |
| 2 | Transcript indexer — incremental parse, four breakdowns, 26-day backfill | ~4h |
| 3 | Calibration fit, demand profile, capacity simulator, confidence states | ~6h |
| 4 | CLI: `stats`, `forecast`, `history` | ~2h |
| 5 | Nav panel dashboard, six views, SVG charts | ~6h |
| 6 | Homepage line, Übersicht widget, dotfiles commit | ~2h |
| 7 | Alerts: two classes, gating, quiet hours | ~2h |

Total roughly 25 hours, three to four focused days.

## Out of scope

- **Feeding the forecast into switch decisions.** Considered and rejected for this round:
  it rewrites `decideSwitch` and can strand threads if the model is wrong. Revisit once the
  forecast has demonstrated accuracy against several weeks of reality.
- **Per-token cost accounting.** The subscription is flat-rate; points, not dollars, are the
  scarce resource.
- **Retention or downsampling policy.** At ~500k rows/year the tables do not warrant one.
- **Exporting or sharing the data.** Transcript-derived data includes project paths and
  should stay local.
