// Recording. Deliberately dumb: no judgement, no clock reads, no decisions.
// Everything interesting happens downstream from the rows this writes.
//
// This module is the whole point of the analytics work. Before it existed,
// every artifact the system produced was a snapshot or a short rolling buffer —
// usage.json overwritten every poll, switch.log trimmed to 200 lines, and
// switches.jsonl holding only the switches that actually fired. The questions
// worth asking ("are three accounts enough", "when does everything go dry")
// are all questions about the past, and the past was being thrown away.
import type { Database } from "better-sqlite3";
import { deriveIntervals, type WindowKind } from "./intervals.ts";
import { insertSamples, readSamples, writeIntervals } from "./store.ts";

/** Exactly server.ts's `Account` shape, minus the fields recording ignores. */
export interface IngestAccount {
  slot: string;
  active: boolean;
  fiveHour: number | null;
  sevenDay: number | null;
  fiveHourResetsAt: string | null;
  sevenDayResetsAt: string | null;
}

export interface IngestResult {
  inserted: number;
  intervals: number;
}

const WINDOWS: WindowKind[] = ["5h", "7d"];

/**
 * How far back to re-derive intervals on each tick.
 *
 * Long enough that a poller outage of a few hours still stitches back together
 * once it recovers, short enough that this is a handful of rows rather than a
 * full-table scan every two minutes. Six hours also comfortably spans one 5h
 * window, so a reset is always visible with its neighbours around it.
 */
const REDERIVE_LOOKBACK_SEC = 6 * 3600;

/**
 * Record one poll.
 *
 * Returns `inserted: 0` for a poll already stored, and short-circuits the
 * interval re-derivation in that case — the bb watch tick runs at 120s against
 * a poller at 180s, so roughly a third of all calls are exactly that.
 */
export function ingestUsage(
  db: Database,
  polledAt: number | null,
  accounts: IngestAccount[],
): IngestResult {
  if (polledAt === null || accounts.length === 0) return { inserted: 0, intervals: 0 };

  const inserted = insertSamples(
    db,
    accounts.map((a) => ({
      polledAt,
      slot: a.slot,
      fiveUtil: a.fiveHour,
      fiveResetsAt: a.fiveHourResetsAt,
      sevenUtil: a.sevenDay,
      sevenResetsAt: a.sevenDayResetsAt,
      active: a.active ? (1 as const) : (0 as const),
    })),
  );
  if (inserted === 0) return { inserted: 0, intervals: 0 };

  let intervals = 0;
  const since = polledAt - REDERIVE_LOOKBACK_SEC;
  for (const a of accounts) {
    const samples = readSamples(db, a.slot, since);
    for (const window of WINDOWS) {
      intervals += writeIntervals(db, deriveIntervals(samples, window));
    }
  }
  return { inserted, intervals };
}
