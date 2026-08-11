import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketIndex, buildProfile, BUCKETS, demandAt, type DemandSample } from "./profile.ts";

/**
 * Epoch seconds for a local wall-clock time. Tests must not assume a timezone —
 * the profile buckets on LOCAL hours by design, so fixtures are built the same
 * way the production code reads them.
 */
const at = (year: number, month: number, day: number, hour: number): number =>
  Math.floor(new Date(year, month - 1, day, hour, 0, 0).getTime() / 1000);

const NOW = at(2026, 8, 11, 12);

test("a profile always has 168 buckets", () => {
  assert.equal(buildProfile([], NOW).buckets.length, BUCKETS);
});

test("bucketIndex is dayOfWeek * 24 + localHour", () => {
  const ts = at(2026, 8, 11, 15); // a Tuesday
  const d = new Date(ts * 1000);
  assert.equal(bucketIndex(ts), d.getDay() * 24 + 15);
});

test("a bucket with observations reports their percentiles", () => {
  const hour = at(2026, 8, 11, 9);
  const samples: DemandSample[] = [10, 20, 30, 40, 50].map((utilPerHour, i) => ({
    ts: hour - i * 7 * 86400, // same local hour and weekday, previous weeks
    utilPerHour,
  }));
  const profile = buildProfile(samples, NOW, 1e6); // effectively no decay
  const b = profile.buckets[bucketIndex(hour)]!;
  assert.equal(b.count, 5);
  assert.ok(b.p10 <= b.p50 && b.p50 <= b.p90);
  assert.equal(b.p50, 30);
});

test("an empty hour borrows its day's mean, not the global median", () => {
  const busyHour = at(2026, 8, 11, 9);
  const otherDayHour = at(2026, 8, 12, 9);
  const profile = buildProfile(
    [
      { ts: busyHour, utilPerHour: 100 },
      { ts: otherDayHour, utilPerHour: 2 },
    ],
    NOW,
    1e6,
  );
  const emptyHourSameDay = profile.buckets[bucketIndex(at(2026, 8, 11, 3))]!;
  assert.equal(emptyHourSameDay.count, 0);
  assert.equal(emptyHourSameDay.p50, 100, "should borrow its own day's mean");
});

test("a day with no observations at all borrows the global median", () => {
  const profile = buildProfile([{ ts: at(2026, 8, 11, 9), utilPerHour: 42 }], NOW, 1e6);
  // Pick a weekday with no samples.
  const emptyDay = new Date(at(2026, 8, 11, 9) * 1000).getDay() === 0 ? 3 : 0;
  const b = profile.buckets[emptyDay * 24 + 5]!;
  assert.equal(b.count, 0);
  assert.equal(b.p50, 42);
});

test("recency weighting lets this week outvote a month ago", () => {
  const hour = at(2026, 8, 11, 9);
  // Eight quiet observations in the current hour against one loud one four
  // weeks back (a whole number of weeks, so it lands in the SAME bucket).
  //
  // Eight and not three: a weighted percentile is a threshold on cumulative
  // weight, so whether one stale outlier still sets the p90 depends on whether
  // its decayed weight is above or below a tenth of the total. With few
  // samples that is a coin flip on the exact half-life rather than a property
  // of the design, and a test should assert the property.
  const samples: DemandSample[] = [
    ...Array.from({ length: 8 }, () => ({ ts: hour, utilPerHour: 10 })),
    { ts: hour - 28 * 86400, utilPerHour: 100 },
  ];

  // Decayed to ~25%, the stale spike is under a tenth of the total weight and
  // drops out of the tail entirely.
  const decayed = buildProfile(samples, NOW, 14).buckets[bucketIndex(hour)]!;
  assert.equal(decayed.p50, 10);
  assert.equal(decayed.p90, 10, "a four-week-old spike should not still set the p90");

  // Undecayed it is one of nine equal votes — over a tenth — so it is the tail.
  const flat = buildProfile(samples, NOW, 1e6).buckets[bucketIndex(hour)]!;
  assert.equal(flat.p50, 10);
  assert.equal(flat.p90, 100, "undecayed, the old spike is still part of the distribution");
});

test("negative and non-finite rates are discarded, not clamped", () => {
  const hour = at(2026, 8, 11, 9);
  const profile = buildProfile(
    [
      { ts: hour, utilPerHour: -5 },
      { ts: hour, utilPerHour: Number.NaN },
      { ts: hour, utilPerHour: 20 },
    ],
    NOW,
    1e6,
  );
  const b = profile.buckets[bucketIndex(hour)]!;
  assert.equal(b.count, 1);
  assert.equal(b.p50, 20);
});

test("demandAt reads the bucket the timestamp falls in", () => {
  const hour = at(2026, 8, 11, 9);
  const profile = buildProfile([{ ts: hour, utilPerHour: 33 }], NOW, 1e6);
  assert.equal(demandAt(profile, hour, "p50"), 33);
  assert.equal(demandAt(profile, hour + 7 * 86400, "p50"), 33, "same slot next week");
});

test("an empty profile yields zero demand rather than NaN", () => {
  const profile = buildProfile([], NOW);
  assert.equal(demandAt(profile, NOW, "p50"), 0);
  assert.equal(demandAt(profile, NOW, "p90"), 0);
  assert.ok(profile.buckets.every((b) => Number.isFinite(b.p50)));
});

test("p10 never exceeds p90 in any bucket", () => {
  const samples: DemandSample[] = [];
  for (let i = 0; i < 200; i++) {
    samples.push({ ts: NOW - i * 3600, utilPerHour: (i * 13) % 47 });
  }
  const profile = buildProfile(samples, NOW);
  assert.ok(profile.buckets.every((b) => b.p10 <= b.p50 && b.p50 <= b.p90));
});
