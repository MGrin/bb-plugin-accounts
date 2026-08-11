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
