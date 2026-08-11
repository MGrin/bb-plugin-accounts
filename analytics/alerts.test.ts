import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLACKOUT_LEAD_SEC,
  EMPTY_MEMORY,
  inQuietHours,
  planAlerts,
  type AlertMemory,
} from "./alerts.ts";
import type { Forecast } from "./forecast.ts";

/** Local wall-clock epoch seconds, so quiet-hours tests are timezone-honest. */
const at = (day: number, hour: number): number =>
  Math.floor(new Date(2026, 7, day, hour, 0, 0).getTime() / 1000);

const NOON = at(11, 12);

const forecast = (over: Partial<Forecast> = {}): Forecast => ({
  confidence: "fitted",
  coverage: { distinctPolls: 5000, latestSampleAt: NOON - 60, staleAfterSec: 900, neededPolls: 1440 },
  generatedAt: NOON,
  horizonSec: 14 * 86400,
  blackout: { earliest: null, likely: null, latest: null, endsAt: null, expectedSec: 0 },
  weeklyExhaustedAt: { a: null, b: null },
  timeline: [],
  slotCurve: [],
  ...over,
});

const soon = (over: Partial<Forecast> = {}) =>
  forecast({
    blackout: {
      earliest: NOON + 3600,
      likely: NOON + 2 * 3600,
      latest: NOON + 3 * 3600,
      endsAt: NOON + 6 * 3600,
      expectedSec: 4 * 3600,
    },
    ...over,
  });

test("quiet hours wrap midnight", () => {
  assert.equal(inQuietHours(at(11, 23), [22, 8]), true);
  assert.equal(inQuietHours(at(11, 2), [22, 8]), true);
  assert.equal(inQuietHours(at(11, 8), [22, 8]), false);
  assert.equal(inQuietHours(at(11, 12), [22, 8]), false);
  assert.equal(inQuietHours(at(11, 21), [22, 8]), false);
});

test("a blackout within the lead time fires once", () => {
  const plan = planAlerts(soon(), EMPTY_MEMORY, NOON);
  assert.equal(plan.fire.length, 1);
  assert.equal(plan.fire[0]!.kind, "blackout");
  assert.ok(plan.memory.blackoutEpisodeKey);
});

test("a drifting forecast within the same hour does not re-fire", () => {
  const first = planAlerts(soon(), EMPTY_MEMORY, NOON);
  const drifted = soon({
    blackout: {
      earliest: NOON + 3500,
      likely: NOON + 2 * 3600 + 240, // four minutes later, same hour
      latest: NOON + 3 * 3600,
      endsAt: NOON + 6 * 3600,
      expectedSec: 4 * 3600,
    },
  });
  const second = planAlerts(drifted, first.memory, NOON + 120);
  assert.equal(second.fire.length, 0);
});

test("a genuinely different episode is allowed to fire again", () => {
  const first = planAlerts(soon(), EMPTY_MEMORY, NOON);
  const later = soon({
    blackout: {
      earliest: NOON + 4 * 3600,
      likely: NOON + 5 * 3600,
      latest: NOON + 6 * 3600,
      endsAt: NOON + 9 * 3600,
      expectedSec: 4 * 3600,
    },
  });
  const second = planAlerts(later, first.memory, NOON + 3 * 3600);
  assert.equal(second.fire.length, 1);
});

test("a blackout beyond the lead time is not yet worth waking anyone", () => {
  const far = soon({
    blackout: {
      earliest: NOON + BLACKOUT_LEAD_SEC + 3600,
      likely: NOON + BLACKOUT_LEAD_SEC + 7200,
      latest: NOON + BLACKOUT_LEAD_SEC + 10800,
      endsAt: null,
      expectedSec: 3600,
    },
  });
  assert.equal(planAlerts(far, EMPTY_MEMORY, NOON).fire.length, 0);
});

test("a provisional forecast never alerts", () => {
  assert.equal(planAlerts(soon({ confidence: "provisional" }), EMPTY_MEMORY, NOON).fire.length, 0);
});

test("a stale forecast never alerts", () => {
  assert.equal(planAlerts(soon({ confidence: "stale" }), EMPTY_MEMORY, NOON).fire.length, 0);
});

test("quiet hours suppress everything, and do not consume the episode", () => {
  const night = at(11, 23);
  const plan = planAlerts(
    soon({
      blackout: {
        earliest: night + 3600,
        likely: night + 2 * 3600,
        latest: night + 3 * 3600,
        endsAt: night + 6 * 3600,
        expectedSec: 3600,
      },
    }),
    EMPTY_MEMORY,
    night,
  );
  assert.equal(plan.fire.length, 0);
  assert.equal(plan.memory.blackoutEpisodeKey, null, "the episode must still be alertable in the morning");
});

test("the weekly alert fires when every window is projected to be spent", () => {
  const plan = planAlerts(
    forecast({ weeklyExhaustedAt: { a: NOON + 86400, b: NOON + 2 * 86400 } }),
    EMPTY_MEMORY,
    NOON,
  );
  assert.equal(plan.fire.length, 1);
  assert.equal(plan.fire[0]!.kind, "weekly");
});

test("the weekly alert does not fire while any window survives", () => {
  const plan = planAlerts(
    forecast({ weeklyExhaustedAt: { a: NOON + 86400, b: null } }),
    EMPTY_MEMORY,
    NOON,
  );
  assert.equal(plan.fire.length, 0);
});

test("the weekly alert fires at most once per calendar day", () => {
  const fc = forecast({ weeklyExhaustedAt: { a: NOON + 86400, b: NOON + 2 * 86400 } });
  const first = planAlerts(fc, EMPTY_MEMORY, NOON);
  assert.equal(first.fire.length, 1);
  const sameDay = planAlerts(fc, first.memory, NOON + 4 * 3600);
  assert.equal(sameDay.fire.length, 0);
  const nextDay = planAlerts(fc, first.memory, at(12, 12));
  assert.equal(nextDay.fire.length, 1);
});

test("no forecast blackout means no alerts and a cleared episode", () => {
  const memory: AlertMemory = { blackoutEpisodeKey: "2026-08-11T05", weeklyAlertedOn: null };
  const plan = planAlerts(forecast(), memory, NOON);
  assert.equal(plan.fire.length, 0);
  assert.equal(plan.memory.blackoutEpisodeKey, null);
});

test("both classes can fire on the same tick", () => {
  const plan = planAlerts(
    soon({ weeklyExhaustedAt: { a: NOON + 86400, b: NOON + 2 * 86400 } }),
    EMPTY_MEMORY,
    NOON,
  );
  assert.deepEqual(plan.fire.map((a) => a.kind).sort(), ["blackout", "weekly"]);
});

test("an account set with no slots does not trigger a weekly alert", () => {
  assert.equal(planAlerts(forecast({ weeklyExhaustedAt: {} }), EMPTY_MEMORY, NOON).fire.length, 0);
});
