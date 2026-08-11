// Consecutive poll samples -> consumption events. Pure: no clock, no I/O.
//
// This is the most error-prone piece of the data layer, which is why it is its
// own module under its own tests. Utilization is monotonically non-decreasing
// WITHIN a window, so a decrease means the window rolled — but a window can
// also roll with no decrease at all, when nothing was burning and it sat at a
// low number through the boundary. `resetsAt` catches that second case; a
// decrease catches the first. Getting either wrong invents burn that never
// happened, and the demand profile is built entirely out of these rows.
import type { UsageSampleRow } from "./store.ts";

export type WindowKind = "5h" | "7d";

export interface BurnInterval {
  slot: string;
  window: WindowKind;
  /** Epoch seconds of the earlier sample. */
  t0: number;
  /** Epoch seconds of the later sample. */
  t1: number;
  /**
   * Utilization points consumed. On a reset this is the post-reset reading
   * alone: the pre-reset remainder is unrecoverable at 1% granularity and
   * guessing at it would be inventing data.
   */
  deltaUtil: number;
  isReset: boolean;
}

const pick = (r: UsageSampleRow, window: WindowKind): { util: number | null; resetsAt: string | null } =>
  window === "5h"
    ? { util: r.fiveUtil, resetsAt: r.fiveResetsAt }
    : { util: r.sevenUtil, resetsAt: r.sevenResetsAt };

/**
 * How far two resetsAt values must diverge before they describe different
 * windows.
 *
 * NOT zero, and this was found the hard way — the first three polls ever
 * recorded produced six intervals, every one flagged as a reset. The poller
 * derives resetsAt as roughly `now + seconds_remaining`, so the same reset
 * instant arrives with microsecond jitter on every single poll:
 *
 *   2026-08-11T09:50:00.881236+00:00
 *   2026-08-11T09:50:00.406176+00:00
 *   2026-08-11T09:50:00.896950+00:00
 *
 * String equality called each of those a fresh window and credited the FULL
 * utilization as burn, which would have reported a 98-point burst every 3
 * minutes forever. A genuine roll moves this by the window length — 5 hours or
 * 7 days — so two minutes of slack cannot mask one and comfortably absorbs the
 * jitter plus any poll-to-poll clock skew.
 */
const RESET_TOLERANCE_MS = 120_000;

/** True when two resetsAt strings describe genuinely different windows. */
function isRescheduled(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  if (a === b) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  // Unparseable on either side: fall back to the utilization-drop signal
  // rather than inventing a reset out of a string we do not understand.
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
  return Math.abs(tb - ta) > RESET_TOLERANCE_MS;
}

/**
 * Derive one window's burn intervals from a slot's samples.
 *
 * Input need not be sorted or deduplicated — the caller reads a tail out of
 * SQLite and should not have to care. Samples whose utilization is null break
 * the series rather than reading as zero: null means the poll failed, and
 * treating a failed poll as "used nothing" would show a burst of consumption
 * on the next successful one.
 */
export function deriveIntervals(samples: UsageSampleRow[], window: WindowKind): BurnInterval[] {
  const byTime = [...samples].sort((a, b) => a.polledAt - b.polledAt);
  const unique: UsageSampleRow[] = [];
  for (const s of byTime) {
    if (unique.length > 0 && unique[unique.length - 1]!.polledAt === s.polledAt) continue;
    unique.push(s);
  }

  const out: BurnInterval[] = [];
  for (let i = 1; i < unique.length; i++) {
    const prev = unique[i - 1]!;
    const curr = unique[i]!;
    const a = pick(prev, window);
    const b = pick(curr, window);
    if (a.util === null || b.util === null) continue;
    if (!(curr.polledAt > prev.polledAt)) continue;

    const rolledBack = b.util < a.util;
    const isReset = rolledBack || isRescheduled(a.resetsAt, b.resetsAt);

    out.push({
      slot: curr.slot,
      window,
      t0: prev.polledAt,
      t1: curr.polledAt,
      deltaUtil: isReset ? b.util : b.util - a.util,
      isReset,
    });
  }
  return out;
}
