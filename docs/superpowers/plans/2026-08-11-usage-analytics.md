# Usage Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give bb-plugin-accounts durable usage history, four-way burn attribution, and a calibrated blackout forecast, without touching the switch decision.

**Architecture:** A new `analytics/` module. Every judgement is a pure function under `node --test`, exactly as `lib.ts` already does for `decideSwitch`; everything I/O-shaped (SQLite, filesystem, schedules) stays in `server.ts` or a thin impure adapter. Poll samples are recorded by the existing `*/2` watch tick; transcripts are indexed by a new `*/15` tick; a fitted tokens→utilization conversion joins the two.

**Tech Stack:** TypeScript (type-stripped, no build), `bb.storage.database()` (host better-sqlite3, WAL), `node --test`, React 19 + Tailwind for the panel, hand-rolled SVG for charts, Python 3 for the Übersicht feed.

## Global Constraints

- **Analytics must never break switching.** Every analytics call inside the watch tick is wrapped in its own `try`/`catch` that logs and swallows. Ingest runs *after* the switch decision.
- **Recording is not conditional on `autoSwitch`.** The watch handler's `if (!autoSwitch) return` becomes a guard around the decision block only.
- **Migrations are append-only.** `bb.storage.migrate()` uses statement index as migration id. Never reorder or edit a shipped statement; only append.
- **No new runtime dependencies.** `better-sqlite3` is provided by the host via `bb.storage.database()` and stays a devDependency (types only). No chart library.
- **Pure judgement lives in `analytics/*.ts` and is tested.** No clock reads, no I/O, no `Date.now()` inside a pure function — `now` is a parameter.
- **Thresholds come from settings**, never hardcoded: `switchAt` (default 97), `weeklyAt` (default 95).
- **The simulator imports `pickBest`/`worst` from `lib.ts`.** It must not reimplement slot selection.
- **Test command:** `npm test` → `node --test --experimental-strip-types lib.test.ts analytics/*.test.ts`
- **Typecheck:** `npm run typecheck` → `tsc --noEmit`. Must pass before every commit.
- **Commit style:** conventional prefix, `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` as the last line.
- **Branch:** `feat/usage-analytics`. Never merge to main.

---

## File Structure

| File | Responsibility |
|---|---|
| `analytics/schema.ts` | Migration statements. Pure data — an array of SQL strings. |
| `analytics/store.ts` | All SQL. Read/write functions over a `Database`. The only file that knows table names. |
| `analytics/intervals.ts` | Pure: consecutive samples → burn intervals, with window-reset detection. |
| `analytics/transcripts.ts` | Pure: one transcript JSONL line → a `TranscriptRow \| null`. |
| `analytics/scan.ts` | Impure: incremental directory walk + byte-offset tailing. Filesystem only, no SQL. |
| `analytics/calibrate.ts` | Pure: non-negative least squares fit of model weights. |
| `analytics/profile.ts` | Pure: intervals → 168-bucket demand profile with percentiles. |
| `analytics/simulate.ts` | Pure: profile + account state → capacity timeline, blackout, weekly exhaustion. |
| `analytics/forecast.ts` | Pure: assembles profile + simulate + confidence into one `Forecast`. |
| `analytics/alerts.ts` | Pure: forecast + alert memory + now → which alerts to fire. |
| `analytics/ingest.ts` | Impure: orchestrates readUsage → store, and scan → store. |
| `app/panel.tsx` | Nav panel route component. |
| `app/charts.tsx` | Hand-rolled SVG chart primitives. |
| `app.tsx` | Registers both slots; homepage section gains one forecast line. |

Tests sit beside their subject: `analytics/intervals.test.ts`, etc.

---

### Task 1: Analytics schema and store

**Files:**
- Create: `analytics/schema.ts`
- Create: `analytics/store.ts`
- Test: `analytics/store.test.ts`
- Modify: `package.json` (test script glob)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `MIGRATIONS: string[]`
  - `interface UsageSampleRow { polledAt: number; slot: string; fiveUtil: number | null; fiveResetsAt: string | null; sevenUtil: number | null; sevenResetsAt: string | null; active: 0 | 1 }`
  - `insertSamples(db: Database, rows: UsageSampleRow[]): number` — returns rows actually inserted (INSERT OR IGNORE)
  - `readSamples(db: Database, slot: string, sinceEpochSec: number): UsageSampleRow[]` — ascending by `polledAt`
  - `latestSampleAt(db: Database): number | null`
  - `countDistinctPolls(db: Database): number`

- [ ] **Step 1: Write `analytics/schema.ts`**

```ts
// Append-only. bb.storage.migrate() uses the array index as the migration id,
// so editing or reordering a shipped statement silently skips it on machines
// that already ran it. Only ever append.
export const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS usage_sample (
     polled_at INTEGER NOT NULL,
     slot TEXT NOT NULL,
     five_util REAL,
     five_resets_at TEXT,
     seven_util REAL,
     seven_resets_at TEXT,
     active INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (polled_at, slot)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_usage_sample_slot_time ON usage_sample (slot, polled_at)`,
  `CREATE TABLE IF NOT EXISTS burn_interval (
     slot TEXT NOT NULL,
     window TEXT NOT NULL,
     t0 INTEGER NOT NULL,
     t1 INTEGER NOT NULL,
     delta_util REAL NOT NULL,
     is_reset INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (slot, window, t1)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_burn_interval_time ON burn_interval (window, t1)`,
  `CREATE TABLE IF NOT EXISTS transcript_msg (
     session_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     ts INTEGER NOT NULL,
     cwd TEXT,
     project TEXT,
     model TEXT,
     is_sidechain INTEGER NOT NULL DEFAULT 0,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     cache_read_tokens INTEGER NOT NULL DEFAULT 0,
     cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (session_id, seq)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_transcript_ts ON transcript_msg (ts)`,
  `CREATE TABLE IF NOT EXISTS model_weight (
     model TEXT PRIMARY KEY,
     points_per_1k REAL NOT NULL,
     fitted_at INTEGER NOT NULL,
     sample_count INTEGER NOT NULL DEFAULT 0,
     residual REAL
   )`,
  `CREATE TABLE IF NOT EXISTS ingest_cursor (
     path TEXT PRIMARY KEY,
     size INTEGER NOT NULL,
     mtime INTEGER NOT NULL,
     byte_offset INTEGER NOT NULL
   )`,
];
```

- [ ] **Step 2: Write the failing store test**

`analytics/store.test.ts` — open an in-memory database with the devDependency `better-sqlite3`, apply `MIGRATIONS` by hand (the host's `migrate()` is not available in tests), then assert:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { MIGRATIONS } from "./schema.ts";
import { insertSamples, readSamples, latestSampleAt, countDistinctPolls } from "./store.ts";

function freshDb() {
  const db = new Database(":memory:");
  for (const stmt of MIGRATIONS) db.exec(stmt);
  return db;
}

test("insertSamples ignores a duplicate (polledAt, slot)", () => {
  const db = freshDb();
  const row = { polledAt: 100, slot: "a", fiveUtil: 10, fiveResetsAt: null, sevenUtil: 5, sevenResetsAt: null, active: 1 as const };
  assert.equal(insertSamples(db, [row]), 1);
  assert.equal(insertSamples(db, [row]), 0);
  assert.equal(readSamples(db, "a", 0).length, 1);
});

test("readSamples returns ascending by polledAt and filters by slot and time", () => {
  const db = freshDb();
  insertSamples(db, [
    { polledAt: 300, slot: "a", fiveUtil: 30, fiveResetsAt: null, sevenUtil: 3, sevenResetsAt: null, active: 1 },
    { polledAt: 100, slot: "a", fiveUtil: 10, fiveResetsAt: null, sevenUtil: 1, sevenResetsAt: null, active: 1 },
    { polledAt: 200, slot: "b", fiveUtil: 20, fiveResetsAt: null, sevenUtil: 2, sevenResetsAt: null, active: 0 },
  ]);
  assert.deepEqual(readSamples(db, "a", 0).map((r) => r.polledAt), [100, 300]);
  assert.deepEqual(readSamples(db, "a", 200).map((r) => r.polledAt), [300]);
});

test("nulls round-trip rather than becoming zero", () => {
  const db = freshDb();
  insertSamples(db, [{ polledAt: 1, slot: "a", fiveUtil: null, fiveResetsAt: null, sevenUtil: null, sevenResetsAt: null, active: 0 }]);
  const [row] = readSamples(db, "a", 0);
  assert.equal(row.fiveUtil, null);
  assert.equal(row.sevenUtil, null);
});

test("latestSampleAt and countDistinctPolls", () => {
  const db = freshDb();
  assert.equal(latestSampleAt(db), null);
  insertSamples(db, [
    { polledAt: 100, slot: "a", fiveUtil: 1, fiveResetsAt: null, sevenUtil: 1, sevenResetsAt: null, active: 1 },
    { polledAt: 100, slot: "b", fiveUtil: 1, fiveResetsAt: null, sevenUtil: 1, sevenResetsAt: null, active: 0 },
    { polledAt: 200, slot: "a", fiveUtil: 2, fiveResetsAt: null, sevenUtil: 1, sevenResetsAt: null, active: 1 },
  ]);
  assert.equal(latestSampleAt(db), 200);
  assert.equal(countDistinctPolls(db), 2);
});
```

- [ ] **Step 3: Run and verify it fails**

Run: `cd /Users/mgrin/Projects/mgrin/bb-plugin-accounts && npm test`
Expected: FAIL — `Cannot find module './store.ts'`

- [ ] **Step 4: Update `package.json` test script**

```json
"test": "node --test --experimental-strip-types lib.test.ts analytics/*.test.ts"
```

- [ ] **Step 5: Implement `analytics/store.ts`**

Use prepared statements. `insertSamples` runs inside `db.transaction`. Return `changes` summed. `active` stored as integer, read back as `0 | 1`.

- [ ] **Step 6: Run tests — expect PASS, then typecheck**

Run: `npm test && npm run typecheck`

- [ ] **Step 7: Commit**

```bash
git add analytics/schema.ts analytics/store.ts analytics/store.test.ts package.json
git commit -m "feat(analytics): schema and sample store"
```

---

### Task 2: Burn interval derivation (pure)

**Files:**
- Create: `analytics/intervals.ts`
- Test: `analytics/intervals.test.ts`

**Interfaces:**
- Consumes: `UsageSampleRow` from `analytics/store.ts`.
- Produces:
  - `type WindowKind = "5h" | "7d"`
  - `interface BurnInterval { slot: string; window: WindowKind; t0: number; t1: number; deltaUtil: number; isReset: boolean }`
  - `deriveIntervals(samples: UsageSampleRow[], window: WindowKind): BurnInterval[]`

**Why this is its own task:** reset detection is the single most error-prone piece of the data layer. Utilization is monotonically non-decreasing *within* a window, so a decrease means the window rolled — but a `resetsAt` change can signal a roll with no decrease at all (a window that rolled while nothing was burning stays at 0). Both must be caught.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveIntervals } from "./intervals.ts";

const s = (polledAt: number, fiveUtil: number | null, fiveResetsAt: string | null = null) =>
  ({ polledAt, slot: "a", fiveUtil, fiveResetsAt, sevenUtil: null, sevenResetsAt: null, active: 1 as const });

test("a rising series yields positive deltas", () => {
  const out = deriveIntervals([s(0, 10), s(100, 15), s(200, 22)], "5h");
  assert.deepEqual(out.map((i) => i.deltaUtil), [5, 7]);
  assert.deepEqual(out.map((i) => i.isReset), [false, false]);
});

test("a decrease marks a reset and credits only the post-reset value", () => {
  const out = deriveIntervals([s(0, 90), s(100, 12)], "5h");
  assert.equal(out.length, 1);
  assert.equal(out[0].isReset, true);
  assert.equal(out[0].deltaUtil, 12);
});

test("a resetsAt change with no decrease is still a reset", () => {
  const out = deriveIntervals([s(0, 40, "2026-08-11T09:00:00Z"), s(100, 41, "2026-08-11T14:00:00Z")], "5h");
  assert.equal(out[0].isReset, true);
  assert.equal(out[0].deltaUtil, 41);
});

test("null utilization breaks the series rather than counting as zero", () => {
  const out = deriveIntervals([s(0, 10), s(100, null), s(200, 30)], "5h");
  assert.equal(out.length, 0);
});

test("out-of-order and duplicate samples are normalised", () => {
  const out = deriveIntervals([s(200, 22), s(0, 10), s(100, 15), s(100, 15)], "5h");
  assert.deepEqual(out.map((i) => [i.t0, i.t1]), [[0, 100], [100, 200]]);
});

test("a zero-length interval is dropped", () => {
  const out = deriveIntervals([s(100, 10), s(100, 12)], "5h");
  assert.equal(out.length, 0);
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npm test` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `analytics/intervals.ts`**

Sort ascending by `polledAt`, drop duplicate timestamps (keep first), select the window's util/resetsAt pair, then walk consecutive pairs. Skip a pair when either util is `null` or `t1 <= t0`. `isReset = util1 < util0 || (resetsAt0 !== null && resetsAt1 !== null && resetsAt0 !== resetsAt1)`. `deltaUtil = isReset ? util1 : util1 - util0`.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Add `writeIntervals` and `readIntervals` to `analytics/store.ts`**

`writeIntervals(db, rows: BurnInterval[]): number` (INSERT OR REPLACE on the `(slot, window, t1)` key), `readIntervals(db, window: WindowKind, sinceEpochSec: number): BurnInterval[]`. Extend `analytics/store.test.ts` with a round-trip test asserting `isReset` survives as a boolean.

- [ ] **Step 6: Run `npm test && npm run typecheck`, then commit**

```bash
git add analytics/intervals.ts analytics/intervals.test.ts analytics/store.ts analytics/store.test.ts
git commit -m "feat(analytics): burn interval derivation with reset detection"
```

---

### Task 3: Wire poll ingest into the watch tick — PHASE 1 SHIPS HERE

**Files:**
- Create: `analytics/ingest.ts`
- Modify: `server.ts:353-403` (the `watch` schedule), `server.ts:104` (plugin body, db handle)

**Interfaces:**
- Consumes: `insertSamples`, `writeIntervals`, `readSamples`, `latestSampleAt`, `deriveIntervals`.
- Produces: `ingestUsage(db: Database, polledAt: number | null, accounts: IngestAccount[]): { inserted: number; intervals: number }` where `IngestAccount` is `{ slot: string; active: boolean; fiveHour: number | null; sevenDay: number | null; fiveHourResetsAt: string | null; sevenHourResetsAt: string | null }` — **note:** name it `sevenDayResetsAt` to match `server.ts`'s existing `Account` type exactly.

**This is the task that stops history being lost.** It is independently shippable and everything after it is additive.

- [ ] **Step 1: Write `analytics/ingest.ts`**

```ts
// Records what the poller already saw. Deliberately dumb: no judgement, no
// clock reads beyond what is handed in. Everything interesting happens
// downstream from the rows this writes.
export function ingestUsage(db, polledAt, accounts) {
  if (polledAt === null || accounts.length === 0) return { inserted: 0, intervals: 0 };
  const inserted = insertSamples(db, accounts.map((a) => ({
    polledAt, slot: a.slot,
    fiveUtil: a.fiveHour, fiveResetsAt: a.fiveHourResetsAt,
    sevenUtil: a.sevenDay, sevenResetsAt: a.sevenDayResetsAt,
    active: a.active ? 1 : 0,
  })));
  if (inserted === 0) return { inserted: 0, intervals: 0 };   // duplicate poll, nothing new to derive
  let intervals = 0;
  for (const a of accounts) {
    // Re-derive only the recent tail. A full re-derivation every 2 minutes
    // would rescan the whole table for one new row.
    const since = polledAt - 6 * 3600;
    const samples = readSamples(db, a.slot, since);
    for (const window of ["5h", "7d"] as const) {
      intervals += writeIntervals(db, deriveIntervals(samples, window));
    }
  }
  return { inserted, intervals };
}
```

- [ ] **Step 2: Open the database once in the plugin body**

In `server.ts`, after `settings` is defined (around line 122):

```ts
  // Analytics storage. Opened once; the host closes it on dispose/reload.
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
```

Import `MIGRATIONS` from `./analytics/schema.ts` and `ingestUsage` from `./analytics/ingest.ts`.

- [ ] **Step 3: Restructure the watch tick so recording is unconditional**

`server.ts:353-360` currently reads:

```ts
  bb.background.schedule("watch", "*/2 * * * *", async () => {
    const { autoSwitch, switchAt, weeklyAt, spreadMargin, cooldownSec, spreadCooldownSec } = await settings.get();
    if (!autoSwitch) return;
    await reconcile(Number(recoverySettings.recoveryGiveUpAfterHours) * 3600);
    const { polledAt, accounts } = await readUsage();
    if (await isStale(polledAt)) return;
```

Replace with:

```ts
  bb.background.schedule("watch", "*/2 * * * *", async () => {
    const { autoSwitch, switchAt, weeklyAt, spreadMargin, cooldownSec, spreadCooldownSec } = await settings.get();
    // Recording is NOT conditional on autoSwitch. A machine with auto-switch off
    // still burns quota, and the history is the whole point of the analytics.
    // It also runs before the staleness gate: a stale poll is still a fact, and
    // INSERT OR IGNORE makes re-reading the same polledAt free.
    const { polledAt, accounts } = await readUsage();
    try {
      const { inserted } = ingestUsage(db, polledAt, accounts);
      if (inserted) bb.log.debug?.(`analytics: recorded poll ${polledAt} (${inserted} rows)`);
    } catch (e) {
      // An analytics failure must never be able to break the path that keeps
      // stuck threads alive.
      bb.log.warn(`analytics ingest failed: ${e instanceof Error ? e.message : e}`);
    }
    if (!autoSwitch) return;
    await reconcile(Number(recoverySettings.recoveryGiveUpAfterHours) * 3600);
    if (await isStale(polledAt)) return;
```

Note the `readUsage()` call moves above the `autoSwitch` guard and the later duplicate call is removed — the rest of the handler already uses the `accounts`/`polledAt` bindings.

- [ ] **Step 4: Verify the handler still compiles and switching logic is untouched**

Run: `npm run typecheck && npm test`
Expected: PASS. `lib.test.ts` must be unchanged and still green — this task must not alter one line of `decideSwitch`.

- [ ] **Step 5: Deploy and confirm rows land**

```bash
bb plugin reload accounts
sleep 150
sqlite3 ~/.bb/plugins/accounts/data.db "select count(*), min(polled_at), max(polled_at) from usage_sample;"
```

Expected: a nonzero count. If the path differs, find it with `bb plugin info accounts`.

- [ ] **Step 6: Commit**

```bash
git add analytics/ingest.ts server.ts
git commit -m "feat(analytics): record every poll — stop losing usage history"
```

---

### Task 4: Transcript parsing and incremental scan

**Files:**
- Create: `analytics/transcripts.ts`, `analytics/scan.ts`
- Test: `analytics/transcripts.test.ts`

**Interfaces:**
- Produces:
  - `interface TranscriptRow { sessionId: string; seq: number; ts: number; cwd: string | null; project: string | null; model: string | null; isSidechain: boolean; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }`
  - `parseTranscriptLine(line: string, sessionId: string, seq: number, project: string | null): TranscriptRow | null`
  - `scanTranscripts(root: string, cursors: Map<string, {size:number;mtime:number;byteOffset:number}>, onRows: (rows: TranscriptRow[], path: string, newCursor: {size:number;mtime:number;byteOffset:number}) => void): Promise<{filesScanned:number; rowsParsed:number}>`

**Parsing is defensive throughout.** The transcript format is undocumented and a Claude Code upgrade can change it. A malformed line is skipped, never fatal.

- [ ] **Step 1: Write the failing parser test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscriptLine } from "./transcripts.ts";

const REAL = JSON.stringify({
  type: "assistant",
  timestamp: "2026-08-11T10:00:00.000Z",
  cwd: "/Users/mgrin/Projects/mgrin/bb-plugin-accounts",
  isSidechain: false,
  message: {
    model: "claude-opus-5",
    usage: { input_tokens: 2, cache_creation_input_tokens: 44579, cache_read_input_tokens: 1200, output_tokens: 235 },
  },
});

test("parses a real assistant record", () => {
  const row = parseTranscriptLine(REAL, "sess-1", 7, "proj");
  assert.ok(row);
  assert.equal(row.sessionId, "sess-1");
  assert.equal(row.seq, 7);
  assert.equal(row.ts, Math.floor(Date.parse("2026-08-11T10:00:00.000Z") / 1000));
  assert.equal(row.model, "claude-opus-5");
  assert.equal(row.inputTokens, 2);
  assert.equal(row.cacheCreationTokens, 44579);
  assert.equal(row.cacheReadTokens, 1200);
  assert.equal(row.outputTokens, 235);
  assert.equal(row.isSidechain, false);
});

test("returns null for a record with no usage block", () => {
  assert.equal(parseTranscriptLine(JSON.stringify({ type: "user", timestamp: "2026-08-11T10:00:00Z" }), "s", 0, null), null);
});

test("returns null for malformed JSON rather than throwing", () => {
  assert.equal(parseTranscriptLine("{not json", "s", 0, null), null);
  assert.equal(parseTranscriptLine("", "s", 0, null), null);
});

test("returns null when the timestamp is missing or unparseable", () => {
  assert.equal(parseTranscriptLine(JSON.stringify({ message: { usage: { output_tokens: 1 } } }), "s", 0, null), null);
  assert.equal(parseTranscriptLine(JSON.stringify({ timestamp: "nope", message: { usage: { output_tokens: 1 } } }), "s", 0, null), null);
});

test("missing token fields default to zero, not NaN", () => {
  const row = parseTranscriptLine(
    JSON.stringify({ timestamp: "2026-08-11T10:00:00Z", message: { model: "m", usage: { output_tokens: 5 } } }), "s", 0, null);
  assert.ok(row);
  assert.equal(row.inputTokens, 0);
  assert.equal(row.cacheReadTokens, 0);
  assert.equal(row.outputTokens, 5);
});

test("isSidechain is read from the top level and defaults false", () => {
  const row = parseTranscriptLine(
    JSON.stringify({ timestamp: "2026-08-11T10:00:00Z", isSidechain: true, message: { usage: { output_tokens: 1 } } }), "s", 0, null);
  assert.equal(row?.isSidechain, true);
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `npm test` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `analytics/transcripts.ts`**

Wrap `JSON.parse` in try/catch returning `null`. Read `usage` from `record.message?.usage`; return `null` when absent. Parse `timestamp` with `Date.parse`, return `null` on `NaN`. Coerce every token field with `Number(x) || 0`.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Implement `analytics/scan.ts`**

Walk `root` two levels deep (`<root>/<project>/<uuid>.jsonl`). For each file, `stat` it; skip when `size` and `mtime` match the cursor. When `size < cursor.size` the file was rewritten — restart from offset 0. Otherwise open a read stream from `cursor.byteOffset`, split on `\n`, keep a trailing partial line unconsumed (advance the offset only past complete lines), and call `parseTranscriptLine` with a monotonically increasing `seq` seeded from the row count already stored for that session. `project` is the file's parent directory name. Batch rows to `onRows` every 1000 rows so a huge backfill does not hold everything in memory.

- [ ] **Step 6: Add `writeTranscriptRows`, `readCursors`, `writeCursor`, `sessionRowCount` to `analytics/store.ts`**

Round-trip test in `analytics/store.test.ts`: writing the same `(sessionId, seq)` twice inserts once.

- [ ] **Step 7: Wire the `*/15` schedule in `server.ts`**

```ts
  // Transcript indexing. Separate from the watch tick because the first run
  // backfills ~550MB and must not sit in the path of a switch decision.
  bb.background.schedule("index-transcripts", "*/15 * * * *", async () => {
    try {
      const root = `${os.homedir()}/.claude/projects`;
      const cursors = readCursors(db);
      const { filesScanned, rowsParsed } = await scanTranscripts(root, cursors, (rows, path, cursor) => {
        writeTranscriptRows(db, rows);
        writeCursor(db, path, cursor);
      });
      if (rowsParsed) bb.log.info(`analytics: indexed ${rowsParsed} message(s) from ${filesScanned} transcript(s)`);
    } catch (e) {
      bb.log.warn(`transcript indexing failed: ${e instanceof Error ? e.message : e}`);
    }
  });
```

- [ ] **Step 8: Run the backfill and verify**

```bash
npm test && npm run typecheck
bb plugin reload accounts
# first index tick runs within 15 min; force it sooner by reloading and waiting
sqlite3 ~/.bb/plugins/accounts/data.db \
  "select count(*), date(min(ts),'unixepoch'), date(max(ts),'unixepoch') from transcript_msg;"
```

Expected: a large count and a min date near 2026-07-16.

- [ ] **Step 9: Commit**

```bash
git add analytics/transcripts.ts analytics/transcripts.test.ts analytics/scan.ts analytics/store.ts analytics/store.test.ts server.ts
git commit -m "feat(analytics): index Claude Code transcripts for retroactive history"
```

---

### Task 5: Model weight calibration

**Files:**
- Create: `analytics/calibrate.ts`
- Test: `analytics/calibrate.test.ts`

**Interfaces:**
- Produces:
  - `interface FitObservation { deltaUtil: number; tokensByModel: Record<string, number> }`
  - `interface ModelWeights { weights: Record<string, number>; residual: number; sampleCount: number }`
  - `fitModelWeights(observations: FitObservation[], priors: Record<string, number>): ModelWeights`
  - `SEED_PRIORS: Record<string, number>` — relative cost per 1k weighted tokens, keyed by model family substring
  - `weightedTokens(row: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }): number`

**Weighting:** cache reads bill at roughly a tenth of fresh input, so `weightedTokens = inputTokens + cacheCreationTokens + 0.1 * cacheReadTokens + 4 * outputTokens`. Output is weighted 4× input, matching the published input/output price ratio.

**Fit:** non-negative least squares via projected gradient descent — 500 iterations, clamping negatives to zero each step. Simple, dependency-free, and sufficient for 2-5 free parameters.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fitModelWeights, weightedTokens, SEED_PRIORS } from "./calibrate.ts";

test("recovers known weights from synthetic observations", () => {
  const truth = { opus: 2.0, sonnet: 0.5 };
  const obs = [
    { tokensByModel: { opus: 10, sonnet: 0 } },
    { tokensByModel: { opus: 0, sonnet: 20 } },
    { tokensByModel: { opus: 5, sonnet: 10 } },
    { tokensByModel: { opus: 3, sonnet: 3 } },
  ].map((o) => ({
    ...o,
    deltaUtil: o.tokensByModel.opus * truth.opus + o.tokensByModel.sonnet * truth.sonnet,
  }));
  const fit = fitModelWeights(obs, {});
  assert.ok(Math.abs(fit.weights.opus - 2.0) < 0.05, `opus was ${fit.weights.opus}`);
  assert.ok(Math.abs(fit.weights.sonnet - 0.5) < 0.05, `sonnet was ${fit.weights.sonnet}`);
  assert.ok(fit.residual < 0.01);
});

test("never returns a negative weight", () => {
  const obs = [
    { deltaUtil: 0, tokensByModel: { a: 100 } },
    { deltaUtil: -5, tokensByModel: { a: 50 } },
  ];
  const fit = fitModelWeights(obs, {});
  assert.ok(fit.weights.a >= 0);
});

test("a model with no observations falls back to its prior", () => {
  const fit = fitModelWeights([{ deltaUtil: 10, tokensByModel: { a: 5 } }], { b: 1.7 });
  assert.equal(fit.weights.b, 1.7);
});

test("no observations at all returns the priors unchanged", () => {
  const fit = fitModelWeights([], SEED_PRIORS);
  assert.deepEqual(fit.weights, SEED_PRIORS);
  assert.equal(fit.sampleCount, 0);
});

test("weightedTokens discounts cache reads and weights output up", () => {
  assert.equal(weightedTokens({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }), 100);
  assert.equal(weightedTokens({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1000, cacheCreationTokens: 0 }), 100);
  assert.equal(weightedTokens({ inputTokens: 0, outputTokens: 25, cacheReadTokens: 0, cacheCreationTokens: 0 }), 100);
});
```

- [ ] **Step 2: Run — expect FAIL. Step 3: implement. Step 4: run — expect PASS.**

- [ ] **Step 5: Add `buildFitObservations(db, sinceEpochSec)` to `analytics/store.ts`**

SQL joining `burn_interval` (window `5h`, `is_reset = 0`) against `transcript_msg` grouped by model, restricted to intervals where the slot was active for the whole interval. Exclude intervals longer than 600 seconds (a poll gap makes the token attribution unreliable).

- [ ] **Step 6: Add the nightly refit schedule to `server.ts`**

`bb.background.schedule("calibrate", "17 4 * * *", ...)` — writes to `model_weight` via a new `writeModelWeights(db, fit, now)`. Wrapped in try/catch.

- [ ] **Step 7: Run `npm test && npm run typecheck`, commit**

```bash
git commit -m "feat(analytics): fit tokens-to-utilization model weights"
```

---

### Task 6: Demand profile and capacity simulator

**Files:**
- Create: `analytics/profile.ts`, `analytics/simulate.ts`
- Test: `analytics/profile.test.ts`, `analytics/simulate.test.ts`

**Interfaces:**
- `analytics/profile.ts` produces:
  - `interface DemandSample { ts: number; utilPerHour: number }`
  - `interface DemandProfile { buckets: Array<{ p10: number; p50: number; p90: number; count: number }>; globalP50: number }` — always 168 buckets, index `dayOfWeek * 24 + hourOfDay` in **local** time
  - `buildProfile(samples: DemandSample[], now: number, halfLifeDays?: number): DemandProfile`
  - `demandAt(profile: DemandProfile, ts: number, percentile: "p10" | "p50" | "p90"): number`
- `analytics/simulate.ts` produces:
  - `interface SimAccount { slot: string; fiveUtil: number; fiveResetsAt: number; sevenUtil: number; sevenResetsAt: number }`
  - `interface SimPolicy { switchAt: number; weeklyAt: number; fiveWindowSec: number; sevenWindowSec: number }`
  - `interface SimResult { blackoutStart: number | null; blackoutEndsAt: number | null; timeline: Array<{ ts: number; headroom: number; blacked: boolean }>; weeklyExhaustedAt: Record<string, number | null> }`
  - `simulate(accounts: SimAccount[], profile: DemandProfile, policy: SimPolicy, startTs: number, horizonSec: number, percentile: "p10"|"p50"|"p90"): SimResult`

- [ ] **Step 1: Write `analytics/profile.test.ts`**

Cases: (a) a bucket with many samples returns their p50; (b) an empty bucket falls back to the day-of-week mean, and an empty day falls back to `globalP50`; (c) recency weighting — two identical buckets, one from 30 days ago and one from today, and the recent one dominates the p50; (d) `demandAt` maps a known epoch to the right local bucket; (e) exactly 168 buckets always.

- [ ] **Step 2: Write `analytics/simulate.test.ts`**

```ts
test("a window rolls to zero at its reset and the account becomes usable again", () => { /* one account at 99% 5h, reset in 1h, zero demand → blackoutEndsAt equals the reset */ });
test("blackout requires EVERY account to trip", () => { /* two accounts, one walled, one fresh → blackoutStart is null */ });
test("a 7d wall counts as a blackout even with a fresh 5h window", () => { /* the 2026-07-31 shape */ });
test("blackoutEndsAt is the soonest reset that actually restores capacity", () => { /* a 5h reset on a weekly-exhausted account does NOT end the blackout */ });
test("demand is spent on the slot pickBest would choose", () => { /* asserts the imported lib.ts selection is used */ });
test("weeklyExhaustedAt is null for an account that never reaches weeklyAt in the horizon", () => {});
test("the slot-count counterfactual is monotonic: more slots never means more blackout", () => {});
test("p90 demand never produces a later blackout than p10", () => {});
```

- [ ] **Step 3: Run — expect FAIL. Step 4: implement both. Step 5: run — expect PASS.**

`simulate` steps in 900-second ticks. Each tick: roll any window whose `resetsAt` has passed (set util 0, schedule next reset `+fiveWindowSec` / `+sevenWindowSec`); compute demand for the tick as `demandAt(profile, ts, percentile) * 0.25`; choose the target slot by calling `pickBest` from `../lib.ts` with the simulated utilizations, falling back to "no slot" when every account trips; add demand to the chosen slot's 5h and 7d utilization; record headroom.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(analytics): demand profile and capacity simulator"
```

---

### Task 7: Forecast assembly, RPC, and CLI

**Files:**
- Create: `analytics/forecast.ts`
- Test: `analytics/forecast.test.ts`
- Modify: `server.ts` (rpcContract, `bb.rpc.register`, `bb.cli.register`)

**Interfaces:**
- `type Confidence = "provisional" | "fitted" | "stale"`
- `interface Forecast { confidence: Confidence; blackout: { p10: number | null; p50: number | null; p90: number | null; endsAt: number | null } ; weeklyExhaustedAt: Record<string, number | null>; timeline: SimResult["timeline"]; slotCurve: Array<{ slots: number; blackoutHoursPerWeek: number }> }`
- `assessConfidence(distinctPolls: number, latestSampleAt: number | null, now: number, staleAfterSec: number): Confidence` — `stale` when the latest sample is older than `staleAfterSec`; `provisional` under 3 days of polls (`distinctPolls < 1440`); otherwise `fitted`.
- `buildForecast(input: ForecastInput): Forecast` — pure; the impure db reads happen in `server.ts` and are passed in.

- [ ] **Step 1: Write `analytics/forecast.test.ts`** — cover `assessConfidence` at every boundary (0 polls, 1439, 1440, stale-overrides-provisional), and that `slotCurve` is non-increasing in `slots`.

- [ ] **Step 2: Run — FAIL. Step 3: implement. Step 4: run — PASS.**

- [ ] **Step 5: Extend `rpcContract` in `server.ts`**

Add `analytics` (breakdowns + timeline for the panel) and `forecast` methods, each `input: z.null()`, with zod output shapes mirroring the interfaces above.

- [ ] **Step 6: Add the three CLI commands**

Register `stats`, `forecast`, `history` in the `commands` array and handle them in `run(argv)` before the `list` fallthrough. Every one supports `--json`. Text mode reuses the existing `bar()` helper for sparklines.

`bb accounts forecast --json` output shape (the Übersicht widget depends on this in Task 10):

```json
{ "confidence": "fitted",
  "blackout": { "p50": 1786440000, "p10": 1786436400, "p90": 1786447200, "endsAt": 1786455000 },
  "weeklyExhaustedAt": { "nikita_scani.xyz": 1786550000 } }
```

- [ ] **Step 7: Verify against the live database**

```bash
npm test && npm run typecheck && bb plugin reload accounts
bb accounts forecast
bb accounts stats --days 7
bb accounts history --days 1
```

Expected: `forecast` reports `provisional` on the first day, with a stated reason. That is correct, not a bug.

- [ ] **Step 8: Commit**

```bash
git commit -m "feat(analytics): forecast assembly, RPC and CLI"
```

---

### Task 8: Nav panel dashboard and homepage forecast line

**Files:**
- Create: `app/charts.tsx`, `app/panel.tsx`
- Modify: `app.tsx`

**Interfaces:**
- `app/charts.tsx` produces `Heatmap`, `StackedArea`, `BandedTimeline`, `Bars` — all plain SVG, all taking `{ data, width, height }` and using Tailwind theme classes (`fill-primary`, `stroke-border`, `text-muted-foreground`) so light/dark both work.

- [ ] **Step 1: Write `app/charts.tsx`**

No chart library. Each component computes its own scales. Colors come from Tailwind theme classes only — never hardcoded hex, or dark mode breaks.

- [ ] **Step 2: Write `app/panel.tsx`**

Six sections in order: capacity timeline with p10-p90 band, hour×weekday heatmap, burn by model tier, burn by agent shape (main vs sidechain), project leaderboard, accounts-needed curve. A `provisional` confidence renders a prominent banner above everything.

Any state that must survive navigation goes to `localStorage` — the panel component unmounts on every route change, so a `useRef` would silently reset.

- [ ] **Step 3: Register both slots in `app.tsx`**

```tsx
export default definePluginApp((app) => {
  app.slots.homepageSection({ id: "claude-accounts", title: "Claude accounts", component: AccountsSection });
  app.slots.navPanel({ id: "usage", title: "Claude usage", icon: "ChartBar", path: "usage", component: UsagePanel });
});
```

- [ ] **Step 4: Add the forecast line to `AccountsSection`**

One line under the existing tiles, rendered only when a blackout is forecast within the horizon and confidence is not `provisional`:

```tsx
{fc?.blackout.p50 && fc.confidence !== "provisional" && (
  <div className="text-xs text-destructive">
    all accounts dry ~{fmt(fc.blackout.p50)} ({fmt(fc.blackout.p10)}–{fmt(fc.blackout.p90)}), back ~{fmt(fc.blackout.endsAt)}
  </div>
)}
```

- [ ] **Step 5: Verify in the app**

```bash
npm run typecheck && bb plugin reload accounts
```

Then **reload the bb window** — `bb plugin reload` swaps only the server half; the frontend bundle keeps running the old `app.js` until the window itself reloads.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(analytics): usage dashboard panel and homepage forecast line"
```

---

### Task 9: Alerts

**Files:**
- Create: `analytics/alerts.ts`
- Test: `analytics/alerts.test.ts`
- Modify: `server.ts` (watch tick)

**Interfaces:**
- `interface AlertMemory { blackoutEpisodeKey: string | null; weeklyAlertedOn: string | null }`
- `type Alert = { kind: "blackout"; title: string; message: string; episodeKey: string } | { kind: "weekly"; title: string; message: string; day: string }`
- `planAlerts(forecast: Forecast, memory: AlertMemory, now: number, quietHours: [number, number]): { fire: Alert[]; memory: AlertMemory }`

- [ ] **Step 1: Write `analytics/alerts.test.ts`**

```ts
test("fires a blackout alert when p50 blackout is within 3 hours", () => {});
test("does not re-fire when the forecast drifts within the same hour bucket", () => {});
test("fires again for a genuinely new episode in a different hour bucket", () => {});
test("suppresses everything during quiet hours 22:00-08:00", () => {});
test("suppresses everything while confidence is provisional", () => {});
test("suppresses everything while confidence is stale", () => {});
test("the weekly alert fires at most once per calendar day", () => {});
test("no blackout forecast means no alerts and unchanged memory", () => {});
```

- [ ] **Step 2: Run — FAIL. Step 3: implement. Step 4: run — PASS.**

`episodeKey` is the predicted blackout start truncated to the hour, as an ISO string. Quiet hours are evaluated in local time and wrap midnight.

- [ ] **Step 5: Wire into the watch tick**

After the existing `alarmIfCornered` call, inside the same try/catch as ingest. Reuse the existing `osascript display notification` pattern; persist `AlertMemory` in `bb.storage.kv` under `alert-memory`.

Add a comment recording why these alerts do not violate the standing "never raise usage limits" directive: they are aggregate planning information, never per-account, never tied to a running task.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(analytics): blackout and weekly-pace alerts"
```

---

### Task 10: Übersicht widget

**Files:**
- Modify: `~/Dev/dotfiles/dotfiles/.local/bin/dash-claude-usage`, `~/Dev/dotfiles/dotfiles/.config/ubersicht/widgets/claude-usage.jsx`

- [ ] **Step 1: Add a `forecast()` call to `dash-claude-usage`**

Mirror the existing `from_bb()` function: same pinned `NODE_PATH`, same timeout discipline, calling `bb accounts forecast --json`. On any failure return `None` — the widget must degrade to omitting the line, never to blanking.

- [ ] **Step 2: Render one line in `claude-usage.jsx`**

Only when `forecast` is present and `confidence != "provisional"`.

- [ ] **Step 3: Verify on the desktop**

```bash
~/Dev/dotfiles/dotfiles/.local/bin/dash-claude-usage | python3 -m json.tool | head -30
```

Then copy both files to their live locations (the dotfiles payload deploys by **copy**, not symlink — a repo edit alone changes nothing live, and a live edit alone is lost on rebuild; do both).

- [ ] **Step 4: Commit in the dotfiles repo**

```bash
cd ~/Dev/dotfiles && git add -A && git commit -m "feat(claude-usage): show blackout forecast on the desktop widget"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §A schema (5 tables) | 1 |
| §A poll ingest, watch-tick placement, unconditional recording | 3 |
| §A transcript ingest, incremental cursors | 4 |
| §A calibration, NNLS, seed priors | 5 |
| §B velocity layer | reused from `lib.ts`, no new task — see note below |
| §B demand profile, capacity simulator, p10/p50/p90 | 6 |
| §B confidence labelling | 7 |
| §B capacity verdict / counterfactual | 6 (`slotCurve` in 7) |
| §C nav panel, homepage line, CLI, Übersicht | 7, 8, 10 |
| §D two alert classes, gating, quiet hours | 9 |
| §Testing | every task, TDD |

**Note on §B layer 1:** the velocity projection already exists in `decideSwitch` and is reused rather than reimplemented, per the Global Constraints. No separate task, deliberately.

**Type consistency:** `UsageSampleRow` (Task 1) is consumed by `deriveIntervals` (Task 2) and `ingestUsage` (Task 3) under the same field names. `BurnInterval` (Task 2) feeds `buildFitObservations` (Task 5) and `buildProfile` (Task 6). `DemandProfile` (Task 6) feeds `simulate` (Task 6) and `buildForecast` (Task 7). `Forecast` (Task 7) feeds `planAlerts` (Task 9) and both frontends (Task 8). `SimResult["timeline"]` is referenced by `Forecast` rather than redeclared. Account field names (`fiveHour`, `sevenDay`, `fiveHourResetsAt`, `sevenDayResetsAt`) match `server.ts`'s existing `Account` type exactly.

**Placeholder scan:** none. Every step names exact files, exact commands, and either shows the code or specifies the algorithm precisely enough to write it one way.
