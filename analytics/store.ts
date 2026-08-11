// All the SQL. The only file that knows table or column names — everything
// else in analytics/ works on the interfaces below, which is what keeps the
// judgement testable without a database.
import type { Database } from "better-sqlite3";
import type { BurnInterval, WindowKind } from "./intervals.ts";
import type { ScanCursor } from "./scan.ts";
import type { TranscriptRow } from "./transcripts.ts";

export interface UsageSampleRow {
  /** Epoch SECONDS, taken from usage.json's own polledAt — not a local clock read. */
  polledAt: number;
  slot: string;
  /** Percent utilization of the rolling 5-hour window; null when the poll failed. */
  fiveUtil: number | null;
  fiveResetsAt: string | null;
  /** Percent utilization of the 7-day window; null when the poll failed. */
  sevenUtil: number | null;
  sevenResetsAt: string | null;
  /** Whether this slot held the Keychain at poll time. */
  active: 0 | 1;
}

interface UsageSampleDbRow {
  polled_at: number;
  slot: string;
  five_util: number | null;
  five_resets_at: string | null;
  seven_util: number | null;
  seven_resets_at: string | null;
  active: number;
}

const toSample = (r: UsageSampleDbRow): UsageSampleRow => ({
  polledAt: r.polled_at,
  slot: r.slot,
  fiveUtil: r.five_util,
  fiveResetsAt: r.five_resets_at,
  sevenUtil: r.seven_util,
  sevenResetsAt: r.seven_resets_at,
  active: r.active ? 1 : 0,
});

/**
 * Record poll snapshots. Returns how many rows were ACTUALLY new.
 *
 * That return value is load-bearing: the bb watch tick runs at 120s against a
 * poller that runs at 180s, so a third of all calls re-present a polledAt that
 * is already stored. Callers use a zero here to skip the (much more expensive)
 * interval re-derivation rather than redoing it for no new data.
 */
export function insertSamples(db: Database, rows: UsageSampleRow[]): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO usage_sample
       (polled_at, slot, five_util, five_resets_at, seven_util, seven_resets_at, active)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertAll = db.transaction((batch: UsageSampleRow[]) => {
    let n = 0;
    for (const r of batch) {
      n += stmt.run(
        r.polledAt,
        r.slot,
        r.fiveUtil,
        r.fiveResetsAt,
        r.sevenUtil,
        r.sevenResetsAt,
        r.active,
      ).changes;
    }
    return n;
  });
  return insertAll(rows);
}

/** One slot's samples at or after `sinceEpochSec`, ascending. */
export function readSamples(db: Database, slot: string, sinceEpochSec: number): UsageSampleRow[] {
  const rows = db
    .prepare(`SELECT * FROM usage_sample WHERE slot = ? AND polled_at >= ? ORDER BY polled_at ASC`)
    .all(slot, sinceEpochSec) as UsageSampleDbRow[];
  return rows.map(toSample);
}

/** Newest polled_at across every slot, or null when nothing is recorded yet. */
export function latestSampleAt(db: Database): number | null {
  const row = db.prepare(`SELECT MAX(polled_at) AS t FROM usage_sample`).get() as { t: number | null };
  return row?.t ?? null;
}

/**
 * How many distinct polls have been recorded.
 *
 * This is the coverage measure behind the forecast's confidence label — three
 * days of 180s polls is ~1440 of them, which is the line below which a weekly
 * forecast is guesswork and says so.
 */
export function countDistinctPolls(db: Database): number {
  const row = db.prepare(`SELECT COUNT(DISTINCT polled_at) AS n FROM usage_sample`).get() as { n: number };
  return row?.n ?? 0;
}

/** Every slot ever recorded, ascending. */
export function knownSlots(db: Database): string[] {
  const rows = db.prepare(`SELECT DISTINCT slot FROM usage_sample ORDER BY slot ASC`).all() as { slot: string }[];
  return rows.map((r) => r.slot);
}

// ── Burn intervals ─────────────────────────────────────────────────────────

interface BurnIntervalDbRow {
  slot: string;
  window: string;
  t0: number;
  t1: number;
  delta_util: number;
  is_reset: number;
}

const toInterval = (r: BurnIntervalDbRow): BurnInterval => ({
  slot: r.slot,
  window: r.window as WindowKind,
  t0: r.t0,
  t1: r.t1,
  deltaUtil: r.delta_util,
  isReset: !!r.is_reset,
});

/**
 * Persist derived intervals. REPLACE, not IGNORE: ingest re-derives a rolling
 * tail every tick, so the same (slot, window, t1) is legitimately recomputed —
 * and a recomputation with a later neighbouring sample can correct a reset
 * flag. Ignoring would freeze the first, less-informed answer.
 */
export function writeIntervals(db: Database, rows: BurnInterval[]): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO burn_interval (slot, window, t0, t1, delta_util, is_reset)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const writeAll = db.transaction((batch: BurnInterval[]) => {
    let n = 0;
    for (const r of batch) {
      n += stmt.run(r.slot, r.window, r.t0, r.t1, r.deltaUtil, r.isReset ? 1 : 0).changes;
    }
    return n;
  });
  return writeAll(rows);
}

/** One window's intervals ending at or after `sinceEpochSec`, ascending by t1. */
export function readIntervals(db: Database, window: WindowKind, sinceEpochSec: number): BurnInterval[] {
  const rows = db
    .prepare(`SELECT * FROM burn_interval WHERE window = ? AND t1 >= ? ORDER BY t1 ASC, slot ASC`)
    .all(window, sinceEpochSec) as BurnIntervalDbRow[];
  return rows.map(toInterval);
}

// ── Transcript messages and scan cursors ───────────────────────────────────

/**
 * Persist parsed messages. IGNORE, not REPLACE: (session_id, message_id) is a
 * stable identity and a re-read of the same bytes — after a rotation, or a
 * crash between batch and cursor — must be a no-op rather than churn.
 * Returns how many were actually new.
 */
export function writeTranscriptRows(db: Database, rows: TranscriptRow[]): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO transcript_msg
       (session_id, message_id, ts, cwd, project, model, entrypoint, is_sidechain,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const writeAll = db.transaction((batch: TranscriptRow[]) => {
    let n = 0;
    for (const r of batch) {
      n += stmt.run(
        r.sessionId,
        r.messageId,
        r.ts,
        r.cwd,
        r.project,
        r.model,
        r.entrypoint,
        r.isSidechain ? 1 : 0,
        r.inputTokens,
        r.outputTokens,
        r.cacheReadTokens,
        r.cacheCreationTokens,
      ).changes;
    }
    return n;
  });
  return writeAll(rows);
}

export function readCursors(db: Database): Map<string, ScanCursor> {
  const rows = db.prepare(`SELECT path, size, mtime, byte_offset FROM ingest_cursor`).all() as {
    path: string;
    size: number;
    mtime: number;
    byte_offset: number;
  }[];
  return new Map(rows.map((r) => [r.path, { size: r.size, mtime: r.mtime, byteOffset: r.byte_offset }]));
}

export function writeCursor(db: Database, path: string, cursor: ScanCursor): void {
  db.prepare(
    `INSERT OR REPLACE INTO ingest_cursor (path, size, mtime, byte_offset) VALUES (?, ?, ?, ?)`,
  ).run(path, cursor.size, cursor.mtime, cursor.byteOffset);
}

// ── Aggregates for the forecast and the four breakdowns ────────────────────

/**
 * The machine's demand history, as points-per-hour samples.
 *
 * IDLE TIME COUNTS. An earlier version filtered to `delta_util > 0` on the
 * theory that only the active slot burns and idle slots contribute nothing —
 * which is true, and which silently deleted every quiet hour from the record.
 * The profile then had no zeros in it at all, so its median hour looked like
 * its busiest hour, and the first live forecast predicted 265 hours of
 * blackout in a 336-hour horizon.
 *
 * The right filter is the ACTIVE slot, whatever it burned, zero included:
 * joining usage_sample on both ends picks exactly the one billable account per
 * interval, so a quiet hour contributes one honest 0 instead of nothing.
 * Reset intervals stay excluded — their delta is a post-reset level, not a rate.
 */
export function readDemandSamples(db: Database, sinceEpochSec: number): Array<{ ts: number; utilPerHour: number }> {
  const rows = db
    .prepare(
      `SELECT b.t0, b.t1, b.delta_util FROM burn_interval b
         JOIN usage_sample s0 ON s0.polled_at = b.t0 AND s0.slot = b.slot AND s0.active = 1
         JOIN usage_sample s1 ON s1.polled_at = b.t1 AND s1.slot = b.slot AND s1.active = 1
        WHERE b.window = '5h' AND b.is_reset = 0 AND b.delta_util >= 0
          AND b.t1 >= ? AND b.t1 > b.t0
        ORDER BY b.t1 ASC`,
    )
    .all(sinceEpochSec) as { t0: number; t1: number; delta_util: number }[];
  return rows.map((r) => ({ ts: r.t1, utilPerHour: (r.delta_util / (r.t1 - r.t0)) * 3600 }));
}

/** Weighted tokens, matching calibrate.weightedTokens, expressed in SQL. */
const WEIGHTED =
  `(input_tokens + cache_creation_tokens + 0.1 * cache_read_tokens + 4 * output_tokens)`;

export interface BurnSlice {
  key: string;
  messages: number;
  /** Thousands of weighted tokens. */
  weightedK: number;
}

export type BurnDimension = "model" | "entrypoint" | "project";

// `project` groups on cwd, which keeps its path separators — see prettyProject.

/** Burn grouped by one of the breakdown dimensions, biggest first. */
export function burnBy(db: Database, dimension: BurnDimension, sinceEpochSec: number): BurnSlice[] {
  // The column name is chosen from a closed set, never interpolated from input.
  const column = dimension === "model" ? "model" : dimension === "entrypoint" ? "entrypoint" : "cwd";
  const rows = db
    .prepare(
      `SELECT COALESCE(${column}, 'unknown') AS key, COUNT(*) AS messages,
              SUM(${WEIGHTED}) / 1000.0 AS weighted_k
         FROM transcript_msg WHERE ts >= ?
        GROUP BY key ORDER BY weighted_k DESC`,
    )
    .all(sinceEpochSec) as { key: string; messages: number; weighted_k: number }[];
  return rows.map((r) => ({ key: r.key, messages: r.messages, weightedK: r.weighted_k ?? 0 }));
}

export interface HourCell {
  /** 0-6, local, matching profile.bucketIndex. */
  dayOfWeek: number;
  hour: number;
  weightedK: number;
}

/**
 * Burn per local hour-of-week, for the heatmap.
 *
 * SQLite's strftime has no local-time mode, so the offset is computed once in
 * JS and applied inside the query. That is correct for a machine that does not
 * change timezone mid-week, which is the only case this dashboard serves.
 */
export function burnByHourOfWeek(db: Database, sinceEpochSec: number, utcOffsetSec: number): HourCell[] {
  const rows = db
    .prepare(
      `SELECT CAST(strftime('%w', ts + ?, 'unixepoch') AS INTEGER) AS dow,
              CAST(strftime('%H', ts + ?, 'unixepoch') AS INTEGER) AS hour,
              SUM(${WEIGHTED}) / 1000.0 AS weighted_k
         FROM transcript_msg WHERE ts >= ?
        GROUP BY dow, hour`,
    )
    .all(utcOffsetSec, utcOffsetSec, sinceEpochSec) as { dow: number; hour: number; weighted_k: number }[];
  return rows.map((r) => ({ dayOfWeek: r.dow, hour: r.hour, weightedK: r.weighted_k ?? 0 }));
}

/** Messages in a time range, for the calibration join. */
export function readMessages(
  db: Database,
  fromTs: number,
  toTs: number,
): Array<{ ts: number; model: string | null } & TokenCountColumns> {
  return db
    .prepare(
      `SELECT ts, model, input_tokens AS inputTokens, output_tokens AS outputTokens,
              cache_read_tokens AS cacheReadTokens, cache_creation_tokens AS cacheCreationTokens
         FROM transcript_msg WHERE ts >= ? AND ts < ? ORDER BY ts ASC`,
    )
    .all(fromTs, toTs) as Array<{ ts: number; model: string | null } & TokenCountColumns>;
}

interface TokenCountColumns {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * Intervals usable for calibration: no reset, short enough that the token
 * attribution is trustworthy, and with the SAME slot active at both ends.
 *
 * That last condition is the important one. A switch inside the interval means
 * the tokens spent in it were billed to two different accounts, so the
 * utilization delta on either one explains only part of the burn.
 */
export function readCalibratableIntervals(
  db: Database,
  sinceEpochSec: number,
  maxDurationSec: number,
): BurnInterval[] {
  const rows = db
    .prepare(
      `SELECT b.* FROM burn_interval b
         JOIN usage_sample s0 ON s0.polled_at = b.t0 AND s0.slot = b.slot AND s0.active = 1
         JOIN usage_sample s1 ON s1.polled_at = b.t1 AND s1.slot = b.slot AND s1.active = 1
        WHERE b.window = '5h' AND b.is_reset = 0 AND b.t1 >= ?
          AND b.t1 - b.t0 <= ? AND b.delta_util >= 0
        ORDER BY b.t1 ASC`,
    )
    .all(sinceEpochSec, maxDurationSec) as BurnIntervalDbRow[];
  return rows.map(toInterval);
}

/**
 * Matched 5h/7d intervals over identical spans, for estimating how much of a
 * weekly window one 5-hour-window point actually costs.
 *
 * Both sides must be non-reset: a reset delta is a post-reset reading, and
 * pairing one against a normal delta would compare a level to a rate.
 */
export function readWindowPairs(
  db: Database,
  sinceEpochSec: number,
): Array<{ deltaFive: number; deltaSeven: number }> {
  return db
    .prepare(
      `SELECT b5.delta_util AS deltaFive, b7.delta_util AS deltaSeven
         FROM burn_interval b5
         JOIN burn_interval b7
           ON b7.slot = b5.slot AND b7.t0 = b5.t0 AND b7.t1 = b5.t1 AND b7.window = '7d'
        WHERE b5.window = '5h' AND b5.is_reset = 0 AND b7.is_reset = 0
          AND b5.delta_util > 0 AND b5.t1 >= ?`,
    )
    .all(sinceEpochSec) as Array<{ deltaFive: number; deltaSeven: number }>;
}

export function writeModelWeights(
  db: Database,
  fit: { weights: Record<string, number>; residual: number; sampleCount: number },
  fittedAt: number,
): void {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO model_weight (model, points_per_1k, fitted_at, sample_count, residual)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const writeAll = db.transaction(() => {
    for (const [model, w] of Object.entries(fit.weights)) {
      stmt.run(model, w, fittedAt, fit.sampleCount, fit.residual);
    }
  });
  writeAll();
}

export function readModelWeights(db: Database): { weights: Record<string, number>; fittedAt: number | null } {
  const rows = db.prepare(`SELECT model, points_per_1k, fitted_at FROM model_weight`).all() as {
    model: string;
    points_per_1k: number;
    fitted_at: number;
  }[];
  const weights: Record<string, number> = {};
  let fittedAt: number | null = null;
  for (const r of rows) {
    weights[r.model] = r.points_per_1k;
    fittedAt = fittedAt === null ? r.fitted_at : Math.max(fittedAt, r.fitted_at);
  }
  return { weights, fittedAt };
}

export interface TranscriptCoverage {
  messages: number;
  firstTs: number | null;
  lastTs: number | null;
}

export function transcriptCoverage(db: Database): TranscriptCoverage {
  const row = db
    .prepare(`SELECT COUNT(*) AS n, MIN(ts) AS lo, MAX(ts) AS hi FROM transcript_msg`)
    .get() as { n: number; lo: number | null; hi: number | null };
  return { messages: row?.n ?? 0, firstTs: row?.lo ?? null, lastTs: row?.hi ?? null };
}
