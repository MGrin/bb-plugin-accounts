// The capacity simulator. Pure — `now` and the inputs are the entire world.
//
// This is what turns "how much is left" into "when does it run out". It steps
// forward in quarter-hours, rolling each account's two windows against their
// real reset times, drawing demand from the profile, and spending it on the
// slot the switcher WOULD pick. That last part is why it imports pickBest from
// lib.ts instead of reimplementing the choice: a simulator that spends
// differently from the switcher is forecasting a machine that does not exist.
import { pickBest, type AccountUsage } from "../lib.ts";
import { demandAt, type DemandProfile, type Percentile } from "./profile.ts";

export interface SimAccount {
  slot: string;
  fiveUtil: number;
  /** Epoch seconds. */
  fiveResetsAt: number;
  sevenUtil: number;
  /** Epoch seconds. */
  sevenResetsAt: number;
}

export interface SimPolicy {
  /** 5h % at which a slot is unusable. The live `switchAt` setting. */
  switchAt: number;
  /** 7d % at which a slot is unusable. The live `weeklyAt` setting. */
  weeklyAt: number;
  fiveWindowSec: number;
  sevenWindowSec: number;
  /**
   * Weekly-window points consumed per one 5-hour-window point.
   *
   * NOT 1. The two windows are percentages of very differently sized budgets,
   * and treating a point of one as a point of the other is the difference
   * between a useful forecast and nonsense — the first run of this simulator
   * predicted 324 hours of blackout in a 336-hour horizon, and five accounts
   * barely outperforming one, purely because of that.
   *
   * Measured from this machine's own recorded intervals: 29.0 points of 5h
   * window cost 4.0 points of weekly window, a ratio of 0.138. So a weekly
   * budget is worth roughly 7¼ full 5-hour windows — which is exactly why the
   * week, not the 5-hour window, is the scarce resource.
   */
  sevenPerFive: number;
}

/**
 * Fallback ratio, used until enough matched intervals exist to measure one.
 *
 * Deliberately a measurement rather than a guess, but a measurement from one
 * machine over seven intervals — estimateSevenPerFive() replaces it as soon as
 * there is data.
 */
export const DEFAULT_SEVEN_PER_FIVE = 0.138;

/**
 * Estimate the ratio from matched 5h/7d intervals over the same span.
 *
 * Totals rather than a mean of per-interval ratios: utilization is reported in
 * whole percent, so a single interval often reads 1 point of 5h against 0 of
 * 7d, and averaging those quantisation artefacts biases the answer toward
 * zero. Summing first lets the rounding cancel.
 */
export function estimateSevenPerFive(
  pairs: Array<{ deltaFive: number; deltaSeven: number }>,
  fallback: number = DEFAULT_SEVEN_PER_FIVE,
): number {
  let five = 0;
  let seven = 0;
  for (const p of pairs) {
    if (p.deltaFive <= 0) continue;
    five += p.deltaFive;
    seven += p.deltaSeven;
  }
  // Too little signal to overrule the fallback. A handful of points of 5h
  // window is a couple of minutes of work and cannot resolve a ratio this
  // small at 1% granularity.
  if (five < 20) return fallback;
  const ratio = seven / five;
  return ratio > 0 && Number.isFinite(ratio) ? ratio : fallback;
}

export interface TimelinePoint {
  ts: number;
  /** Utilization points of headroom summed across every account. */
  headroom: number;
  blacked: boolean;
}

export interface SimResult {
  /** First tick at which NO account can serve a request, or null within the horizon. */
  blackoutStart: number | null;
  /** First tick after blackoutStart at which capacity returns, or null if never within the horizon. */
  blackoutEndsAt: number | null;
  timeline: TimelinePoint[];
  /** Per slot, when its 7-day window first hits weeklyAt. Null if it does not. */
  weeklyExhaustedAt: Record<string, number | null>;
  /** Total blackout time inside the horizon, in seconds. */
  blackoutSec: number;
  /** Projected per-account state at the end of the horizon. */
  finalAccounts: SimAccount[];
}

export const TICK_SEC = 900;

export const DEFAULT_POLICY: Pick<SimPolicy, "fiveWindowSec" | "sevenWindowSec" | "sevenPerFive"> = {
  fiveWindowSec: 5 * 3600,
  sevenWindowSec: 7 * 86400,
  sevenPerFive: DEFAULT_SEVEN_PER_FIVE,
};

/** Points a slot can still burn before EITHER of its windows walls it. */
const headroomOf = (a: SimAccount, policy: SimPolicy): number =>
  Math.max(0, Math.min(policy.switchAt - a.fiveUtil, policy.weeklyAt - a.sevenUtil));

const isWalled = (a: SimAccount, policy: SimPolicy): boolean =>
  a.fiveUtil >= policy.switchAt || a.sevenUtil >= policy.weeklyAt;

/**
 * Roll any window whose reset time has passed.
 *
 * A `while` rather than an `if`: over a 14-day horizon a 5-hour window rolls
 * some 67 times, and an account whose reset time starts in the past (a stale
 * poll, a long-idle slot) would otherwise stay stuck one window behind forever.
 */
function rollWindows(a: SimAccount, ts: number, policy: SimPolicy): void {
  while (a.fiveResetsAt > 0 && ts >= a.fiveResetsAt) {
    a.fiveUtil = 0;
    a.fiveResetsAt += policy.fiveWindowSec;
  }
  while (a.sevenResetsAt > 0 && ts >= a.sevenResetsAt) {
    a.sevenUtil = 0;
    a.sevenResetsAt += policy.sevenWindowSec;
  }
}

/**
 * Step the machine forward and record when it runs dry.
 *
 * Demand is drawn per tick from the profile at the requested percentile, so
 * running this three times at p10/p50/p90 gives the range a single number
 * would pretend not to have. Early on that range is embarrassingly wide, which
 * is the honest answer rather than a defect.
 */
export function simulate(
  accounts: SimAccount[],
  profile: DemandProfile,
  policy: SimPolicy,
  startTs: number,
  horizonSec: number,
  percentile: Percentile,
): SimResult {
  // Copy: the caller's account state describes NOW and must survive being
  // simulated forward three times at three different percentiles.
  const state: SimAccount[] = accounts.map((a) => ({ ...a }));
  const weeklyExhaustedAt: Record<string, number | null> = {};
  for (const a of state) weeklyExhaustedAt[a.slot] = null;

  const timeline: TimelinePoint[] = [];
  let blackoutStart: number | null = null;
  let blackoutEndsAt: number | null = null;
  let blackoutSec = 0;

  for (let ts = startTs; ts < startTs + horizonSec; ts += TICK_SEC) {
    for (const a of state) rollWindows(a, ts, policy);

    const usable = state.filter((a) => !isWalled(a, policy));
    const blacked = usable.length === 0;

    if (blacked) {
      blackoutSec += TICK_SEC;
      if (blackoutStart === null) blackoutStart = ts;
    } else if (blackoutStart !== null && blackoutEndsAt === null) {
      blackoutEndsAt = ts;
    }

    timeline.push({
      ts,
      headroom: state.reduce((s, a) => s + headroomOf(a, policy), 0),
      blacked,
    });

    if (!blacked) {
      // Ask the SWITCHER which slot this would land on. Shaping the usable set
      // as AccountUsage and passing an empty exceptSlot means "consider all of
      // these"; pickBest applies the same lowest-max(5h,7d) rule the live
      // decision uses, including its own weekly cap.
      const asUsage: AccountUsage[] = usable.map((a) => ({
        slot: a.slot,
        active: false,
        fiveHour: a.fiveUtil,
        sevenDay: a.sevenUtil,
      }));
      const chosen = pickBest(asUsage, "", policy.weeklyAt) ?? asUsage[0]!;
      const target = state.find((a) => a.slot === chosen.slot)!;

      // Demand is measured in 5-hour-window points, because that is the
      // window the profile was built from. The weekly window is a percentage
      // of a much larger budget, so the same work moves it by far less.
      const demand = Math.max(0, demandAt(profile, ts, percentile)) * (TICK_SEC / 3600);
      target.fiveUtil += demand;
      target.sevenUtil += demand * policy.sevenPerFive;
    }

    for (const a of state) {
      if (weeklyExhaustedAt[a.slot] === null && a.sevenUtil >= policy.weeklyAt) {
        weeklyExhaustedAt[a.slot] = ts;
      }
    }
  }

  return { blackoutStart, blackoutEndsAt, timeline, weeklyExhaustedAt, blackoutSec, finalAccounts: state };
}
