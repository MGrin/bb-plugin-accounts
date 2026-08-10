// node --test --experimental-strip-types lib.test.ts
//
// The cases below are the ones that actually happened, or that would be
// expensive to discover at 3am: the real 2026-08-09 stranding, a switch into an
// equally-dead account, and thrash.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AccountUsage,
  createRecoverySweeper,
  decideSwitch,
  isLimitError,
  pickBest,
  planSweep,
  type RecoveryAttemptResult,
  type RecoveryPolicy,
  type StuckThreadRecord,
  type StuckThreadStore,
  type SwitchPolicy,
  type ThreadStatus,
  type ThreadStatusPort,
  worst,
} from "./lib.ts";

const POLICY: SwitchPolicy = { switchAt: 97, spreadMargin: 25, cooldownSec: 120, spreadCooldownSec: 1800 };
const acct = (slot: string, fiveHour: number | null, sevenDay: number | null, active = false): AccountUsage =>
  ({ slot, active, fiveHour, sevenDay });

test("worst() is the sooner of the two walls, not the friendlier one", () => {
  assert.equal(worst(acct("a", 70, 83)), 83);
  assert.equal(worst(acct("a", 99, 5)), 99);
});

test("the 2026-08-09 stranding: switches off a spent WEEK toward a fresh account", () => {
  // Exactly what the poller saw and declined to act on: active fine on 5h, two
  // days from its weekly reset, while a slot with 85% of its week free idled.
  const d = decideSwitch(
    [
      acct("withflare", 70, 83, true),
      acct("mr6r1n", 0, 15),
      acct("scani", 100, 15),
    ],
    POLICY,
    3600,
  );
  if (d.action === "none") assert.fail(`expected a spread switch, got none: ${d.reason}`);
  assert.equal(d.action, "spread");
  assert.equal(d.to, "mr6r1n");
});

test("does not switch into an account whose own week is spent", () => {
  const d = decideSwitch([acct("a", 98, 10, true), acct("b", 0, 100)], POLICY, 3600);
  assert.equal(d.action, "none", "a 100% week trips again on the next poll");
});

test("urgent needs the destination to be genuinely better, not merely different", () => {
  const d = decideSwitch([acct("a", 98, 10, true), acct("b", 99, 20)], POLICY, 3600);
  assert.equal(d.action, "none");
  assert.match(d.reason, /no better/);
});

test("urgent overrides the spread cooldown, spread does not", () => {
  const hot = [acct("a", 99, 10, true), acct("b", 1, 5)];
  assert.equal(decideSwitch(hot, POLICY, 300).action, "urgent", "a stalled thread costs more than churn");

  const merelyWorse = [acct("a", 60, 80, true), acct("b", 1, 5)];
  const d = decideSwitch(merelyWorse, POLICY, 300);
  assert.equal(d.action, "none");
  assert.match(d.reason, /spread cooldown/);
});

test("the short cooldown blocks everything, including urgent", () => {
  const d = decideSwitch([acct("a", 99, 10, true), acct("b", 1, 5)], POLICY, 60);
  assert.equal(d.action, "none");
  assert.match(d.reason, /^cooldown/);
});

test("no churn when the alternative is only slightly roomier", () => {
  // The live 00:00 state: active 7%/16%, another slot 0%/15%. Gap of 1.
  const d = decideSwitch([acct("mr6r1n", 7, 16, true), acct("scani", 0, 15)], POLICY, 7200);
  assert.equal(d.action, "none");
  assert.match(d.reason, /gap 1 < margin 25/);
});

test("an unpolled account only LOOKS free and is never a destination", () => {
  assert.equal(pickBest([acct("a", 50, 50, true), acct("b", null, null)], "a"), null);
});

test("spreadMargin 0 disables early switching but leaves urgent alone", () => {
  const off = { ...POLICY, spreadMargin: 0 };
  assert.equal(decideSwitch([acct("a", 60, 80, true), acct("b", 1, 5)], off, 7200).action, "none");
  assert.equal(decideSwitch([acct("a", 99, 80, true), acct("b", 1, 5)], off, 7200).action, "urgent");
});

test("says why it did nothing — a silent no-op is indistinguishable from a broken switcher", () => {
  const reasons = [
    decideSwitch([], POLICY, 7200).reason,
    decideSwitch([acct("a", 50, 50, true)], POLICY, 7200).reason,
    decideSwitch([acct("a", 50, 50, true), acct("b", 49, 49)], POLICY, 7200).reason,
  ];
  for (const r of reasons) assert.ok(r.length > 0, "every decision must carry a reason");
});

test("ties break deterministically, so a tie cannot flap between two slots", () => {
  const accounts = [acct("a", 99, 10, true), acct("z", 5, 5), acct("b", 5, 5)];
  const first = decideSwitch(accounts, POLICY, 7200);
  const again = decideSwitch([...accounts].reverse(), POLICY, 7200);
  if (first.action === "none" || again.action === "none") assert.fail("expected a switch both ways round");
  assert.equal(first.to, "b");
  assert.equal(again.to, "b");
});

test("isLimitError catches every limit wording the vendor has actually sent", () => {
  // The 2026-08-10 outage: this exact string matched nothing and six threads
  // stayed stopped while two accounts sat idle.
  assert.ok(isLimitError("You've hit your session limit · resets 6pm (Asia/Makassar)"));
  assert.ok(isLimitError("Claude AI usage limit reached|1754812800"));
  assert.ok(isLimitError("You've reached your weekly limit for Claude Opus"));
  assert.ok(isLimitError("rate_limit_error"));
  assert.ok(isLimitError("HTTP 429 Too Many Requests"));
  assert.ok(isLimitError("Your subscription has reached its limit for this window"));
  assert.ok(isLimitError("You are out of quota for this model"));
});

test("isLimitError ignores the ordinary ways a thread dies", () => {
  // A false positive burns a fresh account on a bug that will fail there too.
  for (const e of [
    "Error: ENOENT no such file or directory",
    "TypeError: cannot read properties of undefined",
    "Tool use failed: permission denied",
    "session ended by user",
    "Connection reset by peer",
    "AbortError: The operation was aborted",
    "",
    null,
    undefined,
  ]) assert.equal(isLimitError(e), false, `should not match: ${JSON.stringify(e)}`);
});

// ── the trips ported from the Python switcher (2026-08-10 consolidation) ──────
// bb is the sole brain now, so the lessons the Python side had bought and bb had
// not come across with it. Both cases below are real incidents.

const T = 1_000_000; // fixed clock — Date.now() is not allowed to leak in here

test("the 2026-07-31 weekly stranding: a spent WEEK trips urgent, not spread", () => {
  // Active was quiet on 5h and completely out of week, while two slots idled.
  // bb could only have moved this via spread — a 25pt gap AND a 30min cooldown —
  // so a fresh-looking 5h window kept a dead account in place.
  const d = decideSwitch(
    [acct("withflare", 13, 100, true), acct("scani", 0, 33), acct("mr6r1n", 0, 15)],
    POLICY,
    300, // inside the spread cooldown: only an URGENT decision can escape here
  );
  if (d.action === "none") assert.fail(`expected urgent, got none: ${d.reason}`);
  assert.equal(d.action, "urgent");
  assert.equal(d.to, "mr6r1n");
  assert.match(d.reason, /7d/);
});

test("the 2026-08-09 velocity wall: trips below the threshold on projection", () => {
  // Read 90% and was walled before the next 180s poll. A static threshold assumes
  // the next sample arrives in time; a fast burn means it does not.
  const d = decideSwitch(
    [acct("a", 90, 10, true), acct("b", 0, 5)],
    POLICY,
    300,
    { polledAt: T, prev: { slot: "a", fiveHour: 78, polledAt: T - 180 } },
  );
  if (d.action === "none") assert.fail(`expected urgent, got none: ${d.reason}`);
  assert.equal(d.action, "urgent");
  assert.equal(d.to, "b");
  assert.match(d.reason, /velocity/);
});

test("the velocity series resets across a switch — two slots are not one series", () => {
  // Same numbers, but the previous sample belongs to a DIFFERENT slot. Comparing
  // them invents a burn rate out of two unrelated accounts.
  const d = decideSwitch(
    [acct("a", 90, 10, true), acct("b", 0, 5)],
    POLICY,
    300,
    { polledAt: T, prev: { slot: "somebody-else", fiveHour: 78, polledAt: T - 180 } },
  );
  assert.equal(d.action, "none");
  assert.match(d.reason, /spread cooldown/);
});

test("a single sample has no velocity and must not invent one", () => {
  const d = decideSwitch([acct("a", 90, 10, true), acct("b", 0, 5)], POLICY, 300,
    { polledAt: T, prev: null });
  assert.equal(d.action, "none");
  assert.match(d.reason, /spread cooldown/);
});

test("a FALLING burn rate does not project upward", () => {
  const d = decideSwitch(
    [acct("a", 90, 10, true), acct("b", 0, 5)],
    POLICY,
    300,
    { polledAt: T, prev: { slot: "a", fiveHour: 95, polledAt: T - 180 } },
  );
  assert.equal(d.action, "none");
  assert.match(d.reason, /spread cooldown/);
});

test("will not switch INTO a slot at 99% of its week", () => {
  // The old filter was `< 100`, which let bb move into a slot that trips again on
  // the very next tick. Python capped candidates at 95.
  const d = decideSwitch([acct("a", 98, 10, true), acct("b", 0, 99)], POLICY, 3600);
  assert.equal(d.action, "none");
  assert.equal(pickBest([acct("a", 98, 10, true), acct("b", 0, 99)], "a"), null);
});

// ── recovery sweep: resuming every stuck thread, not just the one that just
// failed (2026-08-10 consolidation — six threads sat stopped with capacity
// idle elsewhere because only the just-failed thread was ever resumed) ──────

const RPOLICY: RecoveryPolicy = { attemptCooldownSec: 120, maxAttempts: 5, giveUpAfterSec: 6 * 3600 };
const stuck = (
  threadId: string,
  firstFailedAt: number,
  lastAttemptAt: number | null = null,
  attempts = 0,
): StuckThreadRecord => ({ threadId, providerId: "claude-code", firstFailedAt, lastFailedAt: firstFailedAt, lastAttemptAt, attempts });

test("planSweep drops a candidate that exhausted maxAttempts", () => {
  const plan = planSweep([stuck("a", T, T - 200_000, 5)], T, RPOLICY);
  assert.deepEqual(plan.drop, ["a"]);
  assert.deepEqual(plan.attempt, []);
});

test("planSweep maxAttempts: 0 means unlimited", () => {
  const unlimited = { ...RPOLICY, maxAttempts: 0 };
  const plan = planSweep([stuck("a", T, T - 200_000, 999)], T, unlimited);
  assert.equal(plan.drop.length, 0);
  assert.equal(plan.attempt.length, 1);
});

test("planSweep drops a candidate stuck longer than giveUpAfterSec, regardless of attempts", () => {
  const plan = planSweep([stuck("a", T - 7 * 3600 * 1000, null, 0)], T, RPOLICY);
  assert.deepEqual(plan.drop, ["a"]);
});

test("planSweep giveUpAfterSec: 0 means never give up on time", () => {
  const noGiveUp = { ...RPOLICY, giveUpAfterSec: 0 };
  const plan = planSweep([stuck("a", T - 999 * 3600 * 1000, null, 0)], T, noGiveUp);
  assert.equal(plan.drop.length, 0);
});

test("planSweep puts a still-cooling-down candidate in waiting, not attempt", () => {
  const plan = planSweep([stuck("a", T, T - 60_000, 1)], T, RPOLICY); // 60s < 120s cooldown
  assert.deepEqual(plan.waiting, ["a"]);
  assert.deepEqual(plan.attempt, []);
});

test("planSweep attempts a never-tried candidate immediately", () => {
  const plan = planSweep([stuck("a", T, null, 0)], T, RPOLICY);
  assert.equal(plan.attempt.length, 1);
  assert.equal(plan.attempt[0].threadId, "a");
});

test("planSweep orders attempts oldest-firstFailedAt-first", () => {
  const plan = planSweep([stuck("newer", T, null, 0), stuck("older", T - 10_000, null, 0)], T, RPOLICY);
  assert.deepEqual(plan.attempt.map((c) => c.threadId), ["older", "newer"]);
});

test("planSweep ties break deterministically by threadId", () => {
  const plan = planSweep([stuck("z", T, null, 0), stuck("a", T, null, 0)], T, RPOLICY);
  assert.deepEqual(plan.attempt.map((c) => c.threadId), ["a", "z"]);
});

function inMemoryStore(seed: StuckThreadRecord[] = []): StuckThreadStore {
  let rows = [...seed];
  return {
    async list() { return [...rows]; },
    async upsert(r) { rows = [...rows.filter((x) => x.threadId !== r.threadId), r]; },
    async remove(id) { rows = rows.filter((x) => x.threadId !== id); },
  };
}

function fakeStatus(statuses: Record<string, ThreadStatus>): ThreadStatusPort {
  return { async getStatus(id) { return statuses[id] ?? "not-found"; } };
}

function fakeRecovery(outcomes: Record<string, RecoveryAttemptResult>) {
  const calls: string[] = [];
  return {
    calls,
    async attemptContinue(id: string) {
      calls.push(id);
      return outcomes[id] ?? { outcome: "not-eligible" as const, reason: "no-fixture" };
    },
  };
}

test("sweep drops a candidate whose live status is no longer error, without attempting it", async () => {
  const store = inMemoryStore([stuck("a", T, null, 0)]);
  const recovery = fakeRecovery({});
  const sweeper = createRecoverySweeper({ store, status: fakeStatus({ a: "idle" }), recovery, policy: RPOLICY, now: () => T });
  const result = await sweeper.sweep("periodic");
  assert.deepEqual(result.attempted, []);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(recovery.calls, []);
});

test("sweep removes a candidate from the store on a successful continue", async () => {
  const store = inMemoryStore([stuck("a", T, null, 0)]);
  const sweeper = createRecoverySweeper({
    store,
    status: fakeStatus({ a: "error" }),
    recovery: fakeRecovery({ a: { outcome: "continued" } }),
    policy: RPOLICY,
    now: () => T,
  });
  const result = await sweeper.sweep("reactive");
  assert.deepEqual(result.continued, ["a"]);
  assert.deepEqual(await store.list(), []);
});

test("sweep keeps tracking a candidate after a failed attempt, incrementing attempts", async () => {
  const store = inMemoryStore([stuck("a", T, null, 0)]);
  const sweeper = createRecoverySweeper({
    store,
    status: fakeStatus({ a: "error" }),
    recovery: fakeRecovery({ a: { outcome: "not-eligible", reason: "still hot" } }),
    policy: RPOLICY,
    now: () => T,
  });
  const result = await sweeper.sweep("reactive");
  assert.deepEqual(result.continued, []);
  assert.deepEqual(result.attempted, ["a"]);
  const [after] = await store.list();
  assert.equal(after.attempts, 1);
  assert.equal(after.lastAttemptAt, T);
});

test("sweep isolates one throwing candidate from the rest of the batch", async () => {
  const store = inMemoryStore([stuck("bad", T - 10_000, null, 0), stuck("good", T, null, 0)]);
  const sweeper = createRecoverySweeper({
    store,
    status: {
      async getStatus(id) {
        if (id === "bad") throw new Error("boom");
        return "error";
      },
    },
    recovery: fakeRecovery({ good: { outcome: "continued" } }),
    policy: RPOLICY,
    now: () => T,
  });
  const result = await sweeper.sweep("reactive");
  assert.deepEqual(result.continued, ["good"]);
  assert.equal(result.attempted.includes("bad"), false, "a thrown status check counts as neither attempted nor dropped");
});

test("onLimitFailure preserves firstFailedAt and attempts across repeat failures", async () => {
  const store = inMemoryStore();
  const sweeper = createRecoverySweeper({ store, status: fakeStatus({}), recovery: fakeRecovery({}), policy: RPOLICY, now: () => T });
  await sweeper.onLimitFailure("a", "claude-code", T - 5000);
  await sweeper.onLimitFailure("a", "claude-code", T);
  const [record] = await store.list();
  assert.equal(record.firstFailedAt, T - 5000);
  assert.equal(record.lastFailedAt, T);
  assert.equal(record.attempts, 0);
});
