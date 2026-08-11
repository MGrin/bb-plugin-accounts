// All the SQL. The only file that knows table or column names — everything
// else in analytics/ works on the interfaces below, which is what keeps the
// judgement testable without a database.
import type { Database } from "better-sqlite3";
import type { BurnInterval, WindowKind } from "./intervals.ts";

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
