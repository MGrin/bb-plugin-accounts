import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProfile, type DemandProfile } from "./profile.ts";
import {
  DEFAULT_POLICY,
  DEFAULT_SEVEN_PER_FIVE,
  estimateSevenPerFive,
  simulate,
  type SimAccount,
  type SimPolicy,
  TICK_SEC,
} from "./simulate.ts";

const NOW = 1_786_000_000;
const HOUR = 3600;
const DAY = 86400;

const policy = (over: Partial<SimPolicy> = {}): SimPolicy => ({
  switchAt: 97,
  weeklyAt: 95,
  ...DEFAULT_POLICY,
  ...over,
});

const account = (over: Partial<SimAccount> = {}): SimAccount => ({
  slot: "a",
  fiveUtil: 0,
  fiveResetsAt: NOW + 5 * HOUR,
  sevenUtil: 0,
  sevenResetsAt: NOW + 7 * DAY,
  ...over,
});

/** A profile with one constant rate everywhere, for deterministic arithmetic. */
function flatProfile(utilPerHour: number): DemandProfile {
  const samples = Array.from({ length: 400 }, (_, i) => ({ ts: NOW - i * HOUR, utilPerHour }));
  return buildProfile(samples, NOW, 1e6);
}

const IDLE = flatProfile(0);

test("with no demand nothing ever goes dry", () => {
  const res = simulate([account()], IDLE, policy(), NOW, 2 * DAY, "p50");
  assert.equal(res.blackoutStart, null);
  assert.equal(res.blackoutSec, 0);
  assert.ok(res.timeline.length > 0);
});

test("a walled account recovers exactly at its 5h reset", () => {
  const resetAt = NOW + HOUR;
  const res = simulate(
    [account({ fiveUtil: 99, fiveResetsAt: resetAt })],
    IDLE,
    policy(),
    NOW,
    6 * HOUR,
    "p50",
  );
  assert.equal(res.blackoutStart, NOW);
  assert.equal(res.blackoutEndsAt, resetAt);
});

test("blackout requires EVERY account to be walled", () => {
  const res = simulate(
    [account({ slot: "a", fiveUtil: 99 }), account({ slot: "b", fiveUtil: 0 })],
    IDLE,
    policy(),
    NOW,
    2 * HOUR,
    "p50",
  );
  assert.equal(res.blackoutStart, null);
});

test("a spent weekly window walls an account even with a fresh 5h window", () => {
  // The 2026-07-31 shape: 7d at 100% while 5h looked fine.
  const res = simulate(
    [account({ fiveUtil: 0, sevenUtil: 100 })],
    IDLE,
    policy(),
    NOW,
    2 * HOUR,
    "p50",
  );
  assert.equal(res.blackoutStart, NOW);
});

test("a 5h reset does NOT end a blackout on a weekly-exhausted account", () => {
  const fiveReset = NOW + HOUR;
  const res = simulate(
    [account({ fiveUtil: 99, fiveResetsAt: fiveReset, sevenUtil: 99, sevenResetsAt: NOW + 5 * DAY })],
    IDLE,
    policy(),
    NOW,
    12 * HOUR,
    "p50",
  );
  assert.equal(res.blackoutStart, NOW);
  assert.equal(res.blackoutEndsAt, null, "the weekly wall outlives the 5h reset");
});

test("demand lands on the slot pickBest would choose — the roomiest", () => {
  const res = simulate(
    [account({ slot: "busy", fiveUtil: 50 }), account({ slot: "idle", fiveUtil: 0 })],
    flatProfile(10),
    policy(),
    NOW,
    HOUR,
    "p50",
  );
  const busy = res.finalAccounts.find((a) => a.slot === "busy")!;
  const idle = res.finalAccounts.find((a) => a.slot === "idle")!;
  // One hour at 10 points/hour. All of it belongs on "idle", which starts
  // roomier on max(5h, 7d) — the rule pickBest actually applies.
  assert.equal(busy.fiveUtil, 50, "the busier slot must be untouched");
  assert.ok(Math.abs(idle.fiveUtil - 10) < 1e-9, `idle absorbed ${idle.fiveUtil}`);
});

test("the 5h window rolls repeatedly across a long horizon", () => {
  // 14 days is ~67 rolls of a 5-hour window; rolling with an `if` instead of a
  // `while` would stall one window behind and never recover.
  //
  // weeklyAt is put out of reach on purpose. Both windows grow by the same
  // demand but only the 5h one resets inside this horizon, so with a realistic
  // weekly cap the week always becomes the binding constraint first and the 5h
  // rolls stop being observable — which would test the wrong thing.
  const res = simulate(
    [account({ fiveUtil: 96 })],
    flatProfile(25),
    policy({ weeklyAt: 1e9 }),
    NOW,
    14 * DAY,
    "p50",
  );
  const rolls = res.timeline.filter((p, i) => i > 0 && p.headroom > res.timeline[i - 1]!.headroom).length;
  assert.ok(rolls > 50, `expected many window rolls, saw ${rolls}`);
});

test("a reset time already in the past is caught up rather than stalling", () => {
  const res = simulate(
    [account({ fiveUtil: 99, fiveResetsAt: NOW - 3 * DAY })],
    IDLE,
    policy(),
    NOW,
    2 * HOUR,
    "p50",
  );
  assert.equal(res.blackoutStart, null, "a stale reset time must roll forward immediately");
});

test("weeklyExhaustedAt reports when each slot's week runs out", () => {
  const res = simulate(
    [account({ slot: "a", sevenUtil: 94 })],
    flatProfile(20),
    policy(),
    NOW,
    2 * DAY,
    "p50",
  );
  assert.ok(typeof res.weeklyExhaustedAt.a === "number");
  assert.ok(res.weeklyExhaustedAt.a! >= NOW);
});

test("weeklyExhaustedAt is null for a slot that survives the horizon", () => {
  const res = simulate([account({ slot: "a" })], IDLE, policy(), NOW, 2 * DAY, "p50");
  assert.equal(res.weeklyExhaustedAt.a, null);
});

test("p90 demand never goes dry later than p10 demand", () => {
  const samples = Array.from({ length: 400 }, (_, i) => ({
    ts: NOW - i * HOUR,
    utilPerHour: i % 5 === 0 ? 40 : 4,
  }));
  const profile = buildProfile(samples, NOW, 1e6);
  const accounts = () => [account({ slot: "a" }), account({ slot: "b" })];
  const lo = simulate(accounts(), profile, policy(), NOW, 14 * DAY, "p10");
  const hi = simulate(accounts(), profile, policy(), NOW, 14 * DAY, "p90");
  assert.ok(hi.blackoutSec >= lo.blackoutSec, "heavier demand cannot mean less blackout");
});

test("more accounts never means more blackout", () => {
  const profile = flatProfile(25);
  const mk = (n: number): SimAccount[] =>
    Array.from({ length: n }, (_, i) => account({ slot: `s${i}`, sevenUtil: 60 }));
  const one = simulate(mk(1), profile, policy(), NOW, 7 * DAY, "p50").blackoutSec;
  const two = simulate(mk(2), profile, policy(), NOW, 7 * DAY, "p50").blackoutSec;
  const three = simulate(mk(3), profile, policy(), NOW, 7 * DAY, "p50").blackoutSec;
  assert.ok(two <= one, `2 slots (${two}s) should not be worse than 1 (${one}s)`);
  assert.ok(three <= two, `3 slots (${three}s) should not be worse than 2 (${two}s)`);
});

test("the caller's account state is not mutated", () => {
  const accounts = [account({ fiveUtil: 50 })];
  simulate(accounts, flatProfile(30), policy(), NOW, 2 * DAY, "p50");
  assert.equal(accounts[0]!.fiveUtil, 50);
});

test("the timeline covers the horizon at TICK_SEC resolution", () => {
  const res = simulate([account()], IDLE, policy(), NOW, 4 * HOUR, "p50");
  assert.equal(res.timeline.length, (4 * HOUR) / TICK_SEC);
  assert.equal(res.timeline[0]!.ts, NOW);
  assert.equal(res.timeline[1]!.ts - res.timeline[0]!.ts, TICK_SEC);
});

test("estimateSevenPerFive totals rather than averaging per-interval ratios", () => {
  // The real shape: 1% granularity means many intervals read 1 point of 5h
  // against 0 of 7d. Averaging those ratios would answer near zero; summing
  // first lets the quantisation cancel.
  const pairs = [
    { deltaFive: 1, deltaSeven: 0 },
    { deltaFive: 1, deltaSeven: 0 },
    { deltaFive: 1, deltaSeven: 0 },
    { deltaFive: 1, deltaSeven: 0 },
    { deltaFive: 1, deltaSeven: 0 },
    { deltaFive: 1, deltaSeven: 0 },
    { deltaFive: 24, deltaSeven: 4 },
  ];
  const ratio = estimateSevenPerFive(pairs);
  assert.ok(Math.abs(ratio - 4 / 30) < 1e-9, `ratio was ${ratio}`);
});

test("estimateSevenPerFive keeps the fallback until there is real signal", () => {
  assert.equal(estimateSevenPerFive([]), DEFAULT_SEVEN_PER_FIVE);
  assert.equal(estimateSevenPerFive([{ deltaFive: 3, deltaSeven: 1 }]), DEFAULT_SEVEN_PER_FIVE);
  assert.equal(estimateSevenPerFive([{ deltaFive: 19, deltaSeven: 2 }]), DEFAULT_SEVEN_PER_FIVE);
});

test("estimateSevenPerFive matches this machine's recorded numbers", () => {
  // 29.0 points of 5h window cost 4.0 points of weekly window.
  const ratio = estimateSevenPerFive([{ deltaFive: 29, deltaSeven: 4 }]);
  assert.ok(Math.abs(ratio - 0.1379) < 0.001, `ratio was ${ratio}`);
});

test("a weekly window is spent far slower than a 5h window", () => {
  // The bug this guards: adding demand 1:1 to both windows made the weekly
  // window the binding constraint within hours and predicted near-permanent
  // blackout no matter how many accounts existed.
  const profile = flatProfile(20);
  const oneToOne = simulate([account()], profile, policy({ sevenPerFive: 1 }), NOW, 7 * DAY, "p50");
  const realistic = simulate([account()], profile, policy(), NOW, 7 * DAY, "p50");
  assert.ok(
    realistic.blackoutSec < oneToOne.blackoutSec,
    `realistic ${realistic.blackoutSec}s vs 1:1 ${oneToOne.blackoutSec}s`,
  );
  // The sharper statement: the week lasts several times longer before it walls.
  const ratio = realistic.weeklyExhaustedAt.a! - NOW;
  const naive = oneToOne.weeklyExhaustedAt.a! - NOW;
  assert.ok(ratio > naive * 5, `weekly lasted ${ratio}s vs ${naive}s under a 1:1 model`);
});

test("more accounts helps meaningfully once the weekly ratio is right", () => {
  const profile = flatProfile(20);
  const mk = (n: number): SimAccount[] =>
    Array.from({ length: n }, (_, i) => account({ slot: `s${i}` }));
  const one = simulate(mk(1), profile, policy(), NOW, 7 * DAY, "p50").blackoutSec;
  const three = simulate(mk(3), profile, policy(), NOW, 7 * DAY, "p50").blackoutSec;
  assert.ok(three < one, `3 slots (${three}s) should beat 1 (${one}s)`);
});
