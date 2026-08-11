// What demand looks like, as a function of when. Pure.
//
// A single burn rate cannot forecast anything useful: the same machine that
// burns 40 points an hour on a Tuesday afternoon burns nothing at 04:00. The
// forecast needs a SHAPE, and the shape people actually have is weekly —
// hour of day crossed with day of week, 168 buckets.

export interface DemandSample {
  /** Epoch seconds at the END of the interval this rate was measured over. */
  ts: number;
  /** Utilization points per hour during that interval. */
  utilPerHour: number;
}

export interface DemandBucket {
  p10: number;
  p50: number;
  p90: number;
  /** Observations in this bucket. Zero means the values above are interpolated. */
  count: number;
}

export interface DemandProfile {
  /** Always 168 entries, indexed dayOfWeek * 24 + hourOfDay in LOCAL time. */
  buckets: DemandBucket[];
  globalP50: number;
}

export type Percentile = "p10" | "p50" | "p90";

export const BUCKETS = 168;
const DEFAULT_HALF_LIFE_DAYS = 14;

/** Local-time bucket index for an epoch-seconds timestamp. */
export function bucketIndex(ts: number): number {
  const d = new Date(ts * 1000);
  return d.getDay() * 24 + d.getHours();
}

/**
 * Weighted percentile over (value, weight) pairs.
 *
 * Weighted rather than plain because a habit from five weeks ago should not
 * outvote this week's. Interpolation is deliberately absent — these are noisy
 * counts, and picking the first value whose cumulative weight crosses the
 * threshold is both simpler and less prone to inventing a rate nobody had.
 */
function weightedPercentile(pairs: Array<{ value: number; weight: number }>, p: number): number {
  if (pairs.length === 0) return 0;
  const sorted = [...pairs].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, x) => s + x.weight, 0);
  if (total <= 0) return sorted[Math.floor(sorted.length / 2)]!.value;
  const target = total * p;
  let cumulative = 0;
  for (const x of sorted) {
    cumulative += x.weight;
    if (cumulative >= target) return x.value;
  }
  return sorted[sorted.length - 1]!.value;
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * Build the 168-bucket profile.
 *
 * Buckets with no observations are FILLED rather than left empty, so callers
 * never have to implement the fallback themselves and cannot each get it
 * subtly different: an empty hour borrows its day's mean, and an empty day
 * borrows the global median. `count` stays zero on a filled bucket, which is
 * how the UI knows to describe it as inferred rather than observed.
 */
export function buildProfile(
  samples: DemandSample[],
  now: number,
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS,
): DemandProfile {
  const halfLifeSec = Math.max(1, halfLifeDays) * 86400;
  const grouped: Array<Array<{ value: number; weight: number }>> = Array.from({ length: BUCKETS }, () => []);

  for (const s of samples) {
    if (!Number.isFinite(s.utilPerHour) || s.utilPerHour < 0) continue;
    const ageSec = Math.max(0, now - s.ts);
    const weight = Math.pow(0.5, ageSec / halfLifeSec);
    grouped[bucketIndex(s.ts)]!.push({ value: s.utilPerHour, weight });
  }

  const globalPairs = grouped.flat();
  const globalP50 = weightedPercentile(globalPairs, 0.5);

  // Per-day means, used to fill empty hours with something shaped like the
  // day they sit in rather than a flat global number.
  const dayMean: number[] = [];
  for (let day = 0; day < 7; day++) {
    const values: number[] = [];
    for (let hour = 0; hour < 24; hour++) {
      for (const pair of grouped[day * 24 + hour]!) values.push(pair.value);
    }
    dayMean.push(values.length > 0 ? mean(values) : globalP50);
  }

  const buckets: DemandBucket[] = grouped.map((pairs, i) => {
    if (pairs.length === 0) {
      const filled = dayMean[Math.floor(i / 24)] ?? globalP50;
      return { p10: filled, p50: filled, p90: filled, count: 0 };
    }
    return {
      p10: weightedPercentile(pairs, 0.1),
      p50: weightedPercentile(pairs, 0.5),
      p90: weightedPercentile(pairs, 0.9),
      count: pairs.length,
    };
  });

  return { buckets, globalP50 };
}

/** Expected utilization points per hour at `ts`, at the given percentile. */
export function demandAt(profile: DemandProfile, ts: number, percentile: Percentile): number {
  const bucket = profile.buckets[bucketIndex(ts)];
  if (!bucket) return profile.globalP50;
  return bucket[percentile];
}
