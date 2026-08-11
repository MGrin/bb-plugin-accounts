// Assembling one answer out of the profile and the simulator. Pure — every
// database read happens in server.ts and arrives here as plain data.
import type { DemandProfile } from "./profile.ts";
import { simulate, type SimAccount, type SimPolicy, type SimResult, type TimelinePoint } from "./simulate.ts";

export type Confidence = "provisional" | "fitted" | "stale";

/** Three days of 180s polls. Below this a weekly forecast is arithmetic on noise. */
export const FITTED_POLL_THRESHOLD = 1440;

export const DEFAULT_HORIZON_SEC = 14 * 86400;

export interface Coverage {
  distinctPolls: number;
  latestSampleAt: number | null;
  staleAfterSec: number;
  /**
   * Usable demand observations behind the profile. Reported because it is the
   * number that actually explains a bad forecast: the first live run produced
   * 265 hours of predicted blackout out of 336 from exactly SEVEN samples, all
   * of them taken during one burst.
   */
  demandSamples?: number;
}

/**
 * How much the forecast should be believed.
 *
 * `stale` outranks everything: a forecast built on account state from two
 * hours ago is not cautiously wrong, it is describing a different machine.
 * `provisional` is the honest label for the first few days, when the demand
 * profile has seen a handful of hours and the model weights are still the
 * seeded order-of-magnitude guesses rather than anything fitted.
 */
export function assessConfidence(coverage: Coverage, now: number): Confidence {
  const { distinctPolls, latestSampleAt, staleAfterSec } = coverage;
  if (latestSampleAt === null || now - latestSampleAt > staleAfterSec) return "stale";
  if (distinctPolls < FITTED_POLL_THRESHOLD) return "provisional";
  return "fitted";
}

export interface BlackoutForecast {
  /**
   * Under HEAVY (p90) demand — the pessimistic case, and therefore the
   * soonest. Deliberately not named p90: heavier demand means an EARLIER
   * blackout, so percentile names read backwards at the call site and the
   * inversion is exactly the kind of thing that ships upside down.
   */
  earliest: number | null;
  /** Under median demand. */
  likely: number | null;
  /** Under LIGHT (p10) demand — the optimistic case, and the latest. */
  latest: number | null;
  /** When capacity returns after `likely`, or null if not within the horizon. */
  endsAt: number | null;
  /** Total seconds blacked out within the horizon at median demand. */
  expectedSec: number;
}

export interface SlotCurvePoint {
  slots: number;
  blackoutHoursPerWeek: number;
}

export interface Forecast {
  confidence: Confidence;
  /** Echoed back so every surface can explain a provisional answer the same way. */
  coverage: Coverage & { neededPolls: number };
  generatedAt: number;
  horizonSec: number;
  blackout: BlackoutForecast;
  weeklyExhaustedAt: Record<string, number | null>;
  /** The median-demand timeline, for charting. */
  timeline: TimelinePoint[];
  /** Blackout hours per week as a function of how many accounts exist. */
  slotCurve: SlotCurvePoint[];
}

export interface ForecastInput {
  accounts: SimAccount[];
  profile: DemandProfile;
  policy: SimPolicy;
  now: number;
  coverage: Coverage;
  horizonSec?: number;
  /** Slot counts to evaluate for the counterfactual. Defaults to 1..max(5, actual+2). */
  slotCounts?: number[];
}

/**
 * A hypothetical extra subscription, assumed identical to the ones that exist
 * and starting empty.
 *
 * Both halves of that are assumptions worth stating out loud, and the second
 * is the weaker one: more headroom tends to induce more use, so the real
 * benefit of a fourth account is probably smaller than the curve suggests.
 */
const freshSlot = (index: number, now: number, policy: SimPolicy): SimAccount => ({
  slot: `hypothetical-${index}`,
  fiveUtil: 0,
  fiveResetsAt: now + policy.fiveWindowSec,
  sevenUtil: 0,
  sevenResetsAt: now + policy.sevenWindowSec,
});

function accountsForCount(base: SimAccount[], count: number, now: number, policy: SimPolicy): SimAccount[] {
  if (count <= base.length) return base.slice(0, count);
  const extra = Array.from({ length: count - base.length }, (_, i) => freshSlot(i, now, policy));
  return [...base, ...extra];
}

export function buildForecast(input: ForecastInput): Forecast {
  const { accounts, profile, policy, now, coverage } = input;
  const horizonSec = input.horizonSec ?? DEFAULT_HORIZON_SEC;

  const run = (percentile: "p10" | "p50" | "p90", set: SimAccount[] = accounts): SimResult =>
    simulate(set, profile, policy, now, horizonSec, percentile);

  const median = run("p50");
  const heavy = run("p90");
  const light = run("p10");

  const slotCounts =
    input.slotCounts ?? Array.from({ length: Math.max(5, accounts.length + 2) }, (_, i) => i + 1);
  const weeks = horizonSec / (7 * 86400);
  const slotCurve: SlotCurvePoint[] = slotCounts.map((slots) => {
    const result = simulate(
      accountsForCount(accounts, slots, now, policy),
      profile,
      policy,
      now,
      horizonSec,
      "p50",
    );
    return { slots, blackoutHoursPerWeek: result.blackoutSec / 3600 / weeks };
  });

  return {
    confidence: assessConfidence(coverage, now),
    coverage: { ...coverage, neededPolls: FITTED_POLL_THRESHOLD },
    generatedAt: now,
    horizonSec,
    blackout: {
      earliest: heavy.blackoutStart,
      likely: median.blackoutStart,
      latest: light.blackoutStart,
      endsAt: median.blackoutEndsAt,
      expectedSec: median.blackoutSec,
    },
    weeklyExhaustedAt: median.weeklyExhaustedAt,
    timeline: median.timeline,
    slotCurve,
  };
}

/**
 * Utilization points per hour, from a burn interval.
 *
 * Reset intervals are excluded by the caller, not here — this is only the
 * arithmetic, and an interval shorter than a second would divide by ~zero.
 */
export function ratePerHour(deltaUtil: number, t0: number, t1: number): number | null {
  const seconds = t1 - t0;
  if (!(seconds > 0)) return null;
  return (deltaUtil / seconds) * 3600;
}
