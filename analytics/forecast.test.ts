import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessConfidence,
  buildForecast,
  DEFAULT_HORIZON_SEC,
  FITTED_POLL_THRESHOLD,
  ratePerHour,
  type Coverage,
} from "./forecast.ts";
import { buildProfile, type DemandProfile } from "./profile.ts";
import { DEFAULT_POLICY, type SimAccount, type SimPolicy } from "./simulate.ts";

const NOW = 1_786_000_000;
const HOUR = 3600;
const DAY = 86400;
const STALE = 15 * 60;

const coverage = (over: Partial<Coverage> = {}): Coverage => ({
  distinctPolls: FITTED_POLL_THRESHOLD,
  latestSampleAt: NOW - 60,
  staleAfterSec: STALE,
  ...over,
});

const policy: SimPolicy = { switchAt: 97, weeklyAt: 95, ...DEFAULT_POLICY };

const account = (over: Partial<SimAccount> = {}): SimAccount => ({
  slot: "a",
  fiveUtil: 0,
  fiveResetsAt: NOW + 5 * HOUR,
  sevenUtil: 0,
  sevenResetsAt: NOW + 7 * DAY,
  ...over,
});

function flatProfile(utilPerHour: number): DemandProfile {
  return buildProfile(
    Array.from({ length: 400 }, (_, i) => ({ ts: NOW - i * HOUR, utilPerHour })),
    NOW,
    1e6,
  );
}

test("stale outranks everything, including plenty of polls", () => {
  assert.equal(assessConfidence(coverage({ latestSampleAt: NOW - STALE - 1 }), NOW), "stale");
  assert.equal(
    assessConfidence(coverage({ latestSampleAt: NOW - STALE - 1, distinctPolls: 999_999 }), NOW),
    "stale",
  );
  assert.equal(assessConfidence(coverage({ latestSampleAt: null }), NOW), "stale");
});

test("confidence crosses from provisional to fitted at the poll threshold", () => {
  assert.equal(assessConfidence(coverage({ distinctPolls: 0 }), NOW), "provisional");
  assert.equal(
    assessConfidence(coverage({ distinctPolls: FITTED_POLL_THRESHOLD - 1 }), NOW),
    "provisional",
  );
  assert.equal(assessConfidence(coverage({ distinctPolls: FITTED_POLL_THRESHOLD }), NOW), "fitted");
});

test("a sample exactly at the staleness boundary is not yet stale", () => {
  assert.equal(assessConfidence(coverage({ latestSampleAt: NOW - STALE }), NOW), "fitted");
});

test("ratePerHour converts a burn interval, and refuses a zero-length one", () => {
  assert.equal(ratePerHour(10, 0, 3600), 10);
  assert.equal(ratePerHour(5, 0, 1800), 10);
  assert.equal(ratePerHour(5, 100, 100), null);
  assert.equal(ratePerHour(5, 100, 50), null);
});

test("heavy demand never blacks out later than light demand", () => {
  const fc = buildForecast({
    accounts: [account({ slot: "a" }), account({ slot: "b" })],
    profile: flatProfile(30),
    policy,
    now: NOW,
    coverage: coverage(),
  });
  assert.ok(fc.blackout.earliest !== null, "this fixture should go dry");
  assert.ok(fc.blackout.likely !== null);
  assert.ok(fc.blackout.earliest! <= fc.blackout.likely!);
  assert.ok(fc.blackout.likely! <= (fc.blackout.latest ?? Number.POSITIVE_INFINITY));
});

test("an idle machine forecasts no blackout at all", () => {
  const fc = buildForecast({
    accounts: [account()],
    profile: flatProfile(0),
    policy,
    now: NOW,
    coverage: coverage(),
  });
  assert.equal(fc.blackout.likely, null);
  assert.equal(fc.blackout.earliest, null);
  assert.equal(fc.blackout.expectedSec, 0);
});

test("the slot curve is non-increasing — more accounts never means more blackout", () => {
  const fc = buildForecast({
    accounts: [account({ slot: "a", sevenUtil: 50 })],
    profile: flatProfile(25),
    policy,
    now: NOW,
    coverage: coverage(),
  });
  assert.ok(fc.slotCurve.length >= 5);
  for (let i = 1; i < fc.slotCurve.length; i++) {
    assert.ok(
      fc.slotCurve[i]!.blackoutHoursPerWeek <= fc.slotCurve[i - 1]!.blackoutHoursPerWeek + 1e-9,
      `slot ${fc.slotCurve[i]!.slots} was worse than ${fc.slotCurve[i - 1]!.slots}`,
    );
  }
});

test("the slot curve starts at the real account count's own result", () => {
  const accounts = [account({ slot: "a" }), account({ slot: "b" })];
  const fc = buildForecast({
    accounts,
    profile: flatProfile(40),
    policy,
    now: NOW,
    coverage: coverage(),
    slotCounts: [2],
  });
  const weeks = fc.horizonSec / (7 * DAY);
  assert.equal(fc.slotCurve.length, 1);
  assert.ok(Math.abs(fc.slotCurve[0]!.blackoutHoursPerWeek - fc.blackout.expectedSec / 3600 / weeks) < 1e-9);
});

test("the forecast carries its horizon and generation time", () => {
  const fc = buildForecast({
    accounts: [account()],
    profile: flatProfile(1),
    policy,
    now: NOW,
    coverage: coverage(),
  });
  assert.equal(fc.generatedAt, NOW);
  assert.equal(fc.horizonSec, DEFAULT_HORIZON_SEC);
  assert.ok(fc.timeline.length > 0);
});

test("a custom horizon is respected", () => {
  const fc = buildForecast({
    accounts: [account()],
    profile: flatProfile(1),
    policy,
    now: NOW,
    coverage: coverage(),
    horizonSec: 2 * DAY,
  });
  assert.equal(fc.horizonSec, 2 * DAY);
  assert.equal(fc.timeline[fc.timeline.length - 1]!.ts < NOW + 2 * DAY, true);
});

test("weeklyExhaustedAt names every real slot", () => {
  const fc = buildForecast({
    accounts: [account({ slot: "a" }), account({ slot: "b" })],
    profile: flatProfile(20),
    policy,
    now: NOW,
    coverage: coverage(),
  });
  assert.deepEqual(Object.keys(fc.weeklyExhaustedAt).sort(), ["a", "b"]);
});

test("the caller's accounts survive the counterfactual sweep unmutated", () => {
  const accounts = [account({ slot: "a", fiveUtil: 33 })];
  buildForecast({ accounts, profile: flatProfile(30), policy, now: NOW, coverage: coverage() });
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]!.fiveUtil, 33);
});
