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
  isLimitFailure,
  type ListedThread,
  pickBest,
  planAdoption,
  planSweep,
  rateLimitStatusFrom,
  type RecoveryAttemptResult,
  type RecoveryPolicy,
  type StuckThreadRecord,
  type StuckThreadStore,
  type SwitchPolicy,
  capacityVerdict,
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

// ── the 2026-08-11 outage: the trigger never fired at all ────────────────────
//
// Proven from ~/.bb/logs/server.*.log and bb.db that morning: grep for
// "reactive" across every bb server log this machine has ever written returns
// ZERO hits, the kv key "stuck-threads" had never once existed, and all 39
// sweep lines ever logged say "holding 0 thread(s)". Cause: bb's
// emitThreadFailed fills `error` from getLastThreadErrorMessage(), which
// queries ONLY events of type "system/error" — while every provider rate limit
// is stored as type "provider/error". Census of the whole event table that
// morning: 100 provider/error rows against 1 system/error row. So `error` is
// null on every real limit failure and isLimitError(null) is false, forever.
//
// isLimitError is not wrong; it is simply never handed a string. The fix is a
// second signal, so the trigger stops depending on a field bb does not fill.

test("a limit failure is recognised from the rate-limit snapshot when bb sends error:null", () => {
  // The exact shape of the 2026-08-11 loss: thr_3waqz7vb9w died on "You've hit
  // your session limit · resets 2:10am" recorded as provider/error, so
  // thread.failed carried error:null — but the preceding
  // provider/rateLimits/updated event had status "blocked".
  assert.ok(isLimitFailure({ error: null, rateLimitStatus: "blocked" }));
});

// bb 0.39.0 removed threads.rateLimitRecovery() (get-bb/bb#1623), which is
// where the second signal used to come from: `reason === "eligible"`, bb's own
// verdict that it held a replayable failed request. Nothing outside bb's
// provider-retry plugin can produce a `reason` now, so the signal is gone. It
// cost no coverage: of the 245 limit failures this plugin logged between
// 2026-08-09 and the removal, 245 carried `rate limits blocked` as well and
// none was caught by the reason alone.

test("the error string still decides on its own when bb does fill it in", () => {
  assert.ok(isLimitFailure({ error: "You've hit your session limit · resets 6pm" }));
  assert.ok(isLimitFailure({ error: "HTTP 429 Too Many Requests", rateLimitStatus: "allowed" }));
});

test("an ordinary crash is not a limit failure just because it was inspected", () => {
  // spawn codex ENOENT killed a thread the same night. Tracking it would spend
  // five resume attempts on a binary that is still missing.
  for (const signal of [
    { error: "Provider \"codex\" failed to start: spawn codex ENOENT" },
    { error: null, rateLimitStatus: "allowed" },
    { error: null, rateLimitStatus: "unknown" },
    { error: null },
    {},
  ]) assert.equal(isLimitFailure(signal), false, `should not match: ${JSON.stringify(signal)}`);
});

const limitsRow = (providerId: string, status: string) => ({
  type: "provider/rateLimits/updated",
  data: { rateLimits: { providerId, status } },
});

// ── where the rate-limit status comes from now ───────────────────────────────
//
// It used to be one field on threads.rateLimitRecovery()'s answer. bb 0.39.0
// removed that method (get-bb/bb#1623) and the call threw, swallowed, from
// 2026-08-19T05:40Z: 196 warnings, 245 detections in the ten days before and
// ZERO in the two days after. It is read off the thread's own
// provider/rateLimits/updated events now, newest-first.

test("the newest observation wins — an older block does not outlive it", () => {
  // The ordering bug this guards: a thread blocked at 06:00 and allowed again
  // at 07:00 must not still read `blocked`, or every sweep re-adopts a thread
  // whose account has already climbed out of the window.
  const page = [
    limitsRow("claude-code", "allowed"),
    limitsRow("claude-code", "blocked"),
  ];
  assert.equal(rateLimitStatusFrom(page, "claude-code"), "allowed");
});

test("a blocked observation is found and reported", () => {
  assert.equal(rateLimitStatusFrom([limitsRow("claude-code", "blocked")], "claude-code"), "blocked");
});

test("another provider's observation is not this provider's answer", () => {
  // A thread that has run on two providers interleaves their observations, so
  // the newest event of this type need not be the one being asked about.
  const page = [limitsRow("codex", "blocked"), limitsRow("claude-code", "allowed")];
  assert.equal(rateLimitStatusFrom(page, "claude-code"), "allowed");
  assert.equal(rateLimitStatusFrom([limitsRow("codex", "blocked")], "claude-code"), null);
});

test("no observation is null, never a status — no signal must not read as one", () => {
  assert.equal(rateLimitStatusFrom([], "claude-code"), null);
  // isLimitFailure must then decline, or a thread bb has said nothing about
  // gets adopted on an absence of evidence.
  assert.equal(isLimitFailure({ error: null, rateLimitStatus: rateLimitStatusFrom([], "claude-code") }), false);
});

// ── the second half of the same outage: detection is not resumption ──────────
//
// Even with detection fixed, thr_3waqz7vb9w could not have been resumed by
// bb's own route: `bb thread retry` refused it with "no-rate-limit-state",
// because the limit arrived as an agentMessage rather than a stored recovery
// candidate. What actually revived it by hand was an ordinary follow-up
// message (`bb thread tell --mode auto`).
//
// bb 0.39.0 then removed the replay route entirely (get-bb/bb#1623) — it lives
// in bb's builtin provider-retry plugin now, scheduled for the moment the
// blocked window rolls over. So the nudge is no longer a fallback, it is the
// whole mechanism, and shouldNudgeAfterIneligible() went with the reasons it
// was gating on. The gates that remain are planSweep's, exercised below: a
// candidate is only attempted while it is still `error`, while some account
// has capacity, and once per cooldown.

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

// --- DRAIN THE WEEK TO THE WALL (2026-08-13) ---------------------------------
//
// weeklyAt used to be 95, which abandoned an account with 5% of its week left AND
// refused to switch INTO one. With four accounts that is a fifth of an account's
// week never spent, and — the shape mgrin actually hit — once every slot passed
// 95 the destination cap made pickBest return null, so nothing switched and
// threads waited on tokens that existed. weeklyAt is now 100: the WALL, not a
// safety margin. Nothing below 100 is a reason to move, and nothing below 100 is
// an ineligible destination.

test("a 99% week is not a reason to move — that 1% is real capacity", () => {
  // Under weeklyAt=95 this tripped urgent and stranded the rest of the week.
  const d = decideSwitch([acct("a", 10, 99, true), acct("b", 10, 90)], POLICY, 3600);
  assert.equal(d.action, "none", "only the wall itself may end an account's week");
});

test("a 99% account is still a valid destination", () => {
  // The destination cap is the wall too. Under weeklyAt=95 this returned null and
  // froze the machine with capacity left in every slot.
  assert.equal(pickBest([acct("b", 10, 99)], "none-active")?.slot, "b");
  assert.equal(pickBest([acct("b", 10, 100)], "none-active"), null, "but a spent week is not");
});

test("the endgame: every account past 95 still rotates instead of freezing", () => {
  // 2026-08-13, live: 98 / 99 / 95 and a fourth slot. Every one of them was above
  // the old cap, so pickBest returned null, decideSwitch said "no eligible
  // alternative slot", and the sweeper called the machine walled — while ~5% of
  // four separate weeks sat unspent.
  const d = decideSwitch(
    [acct("mr6r1n", 99, 98, true), acct("scani", 39, 99), acct("withflare", 44, 96)],
    POLICY,
    3600,
  );
  if (d.action === "none") assert.fail(`expected a switch, got none: ${d.reason}`);
  assert.equal(d.to, "withflare", "the least-spent survivor, not nobody");
});

test("at 100 the week is genuinely over and still trips urgent", () => {
  // The 2026-07-31 regression, restated at the new threshold: draining to the wall
  // means moving AT the wall, not sitting on a dead account forever.
  const d = decideSwitch([acct("a", 13, 100, true), acct("b", 0, 99)], POLICY, 300);
  if (d.action === "none") assert.fail(`expected urgent, got none: ${d.reason}`);
  assert.equal(d.action, "urgent");
  assert.equal(d.to, "b");
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

test("will not switch INTO a slot whose week is actually gone, but 99% is fair game", () => {
  // This test used to cap destinations at 95, on the reasoning that a 99% slot
  // "trips again on the very next tick". That was only true while the TRIGGER was
  // also 95 — it tripped on arrival. With the trigger at the wall, a 99% slot has
  // 1% of a week left and is a perfectly good destination; arriving there and
  // later hitting the wall is the intended trade, and the reactive path catches
  // the thread that hits it. Only a spent week is disqualifying.
  const spent = decideSwitch([acct("a", 98, 100, true), acct("b", 0, 100)], POLICY, 3600);
  assert.equal(spent.action, "none", "100% is the wall — arriving there is arriving nowhere");

  // Same dead active, but the destination has 1% of a week left. That 1% is the
  // whole point of the change: it is capacity, and it gets spent.
  const nearly = decideSwitch([acct("a", 98, 100, true), acct("b", 0, 99)], POLICY, 3600);
  assert.equal(nearly.action, "urgent");
  assert.equal(nearly.to, "b");
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

// ── capacity gating: a dry spell must not be charged to the thread ───────────
// Asked 2026-08-10: "when all accounts are unusable, will the threads still be
// resumed once one frees up?" With the live defaults they would NOT have been —
// 5 attempts 120s apart drops everything 10 minutes in, and the soonest reset
// was 87 minutes away.

const NO_CAPACITY = (sinceLastSweepMs = 120_000) => ({ available: false, sinceLastSweepMs });

test("cornered: no capacity means no attempts and — critically — no drops", () => {
  // Both give-up rules would fire here: attempts exhausted AND stuck 7h.
  const plan = planSweep(
    [stuck("a", T - 7 * 3600 * 1000, T - 200_000, 5), stuck("b", T, null, 0)],
    T,
    RPOLICY,
    NO_CAPACITY(),
  );
  assert.deepEqual(plan.attempt, [], "attempting while every account is walled is doomed by definition");
  assert.deepEqual(plan.drop, [], "dropping here loses a thread that was only ever waiting for capacity");
  assert.deepEqual(plan.waiting, ["a", "b"]);
  assert.equal(plan.stallCreditMs, 120_000);
});

test("the attempts budget survives a long dry spell", () => {
  // 87 minutes cornered — the real gap to scani's reset — at one sweep per 2min.
  let rec = stuck("a", T, null, 0);
  for (let i = 0; i < 44; i++) {
    const at = T + i * 120_000;
    const plan = planSweep([rec], at, RPOLICY, NO_CAPACITY());
    assert.deepEqual(plan.drop, [], `dropped at sweep ${i}`);
    assert.deepEqual(plan.attempt, [], `attempted at sweep ${i}`);
    rec = { ...rec, stalledMs: (rec.stalledMs ?? 0) + plan.stallCreditMs };
  }
  assert.equal(rec.attempts, 0, "not one attempt spent on a doomed retry");

  // Capacity returns: the thread is still tracked and immediately eligible.
  const after = planSweep([rec], T + 44 * 120_000, RPOLICY);
  assert.deepEqual(after.attempt.map((r) => r.threadId), ["a"]);
});

test("stalled time is excluded from the give-up clock", () => {
  // Stuck 7h wall-clock, 6h of it with nothing able to serve it. Only 1h counts.
  const rec = { ...stuck("a", T - 7 * 3600 * 1000, null, 0), stalledMs: 6 * 3600 * 1000 };
  assert.deepEqual(planSweep([rec], T, RPOLICY).drop, [], "6h of outage is not the thread's fault");

  // Without the credit the same record is dropped — proving the field is doing the work.
  assert.deepEqual(planSweep([stuck("a", T - 7 * 3600 * 1000, null, 0)], T, RPOLICY).drop, ["a"]);
});

test("a thread genuinely past give-up is still dropped once capacity exists", () => {
  const rec = { ...stuck("a", T - 7 * 3600 * 1000, null, 0), stalledMs: 30 * 60 * 1000 };
  assert.deepEqual(planSweep([rec], T, RPOLICY).drop, ["a"], "6.5h of SERVABLE time is a real give-up");
});

test("the sweeper holds while cornered, then resumes when capacity returns", async () => {
  let capacity = false;
  const records = new Map<string, StuckThreadRecord>();
  const attempts: string[] = [];
  let clock = T;

  const sweeper = createRecoverySweeper({
    store: {
      list: async () => [...records.values()],
      upsert: async (r) => void records.set(r.threadId, r),
      remove: async (id) => void records.delete(id),
    },
    status: { getStatus: async () => "error" },
    recovery: {
      attemptContinue: async (id) => {
        attempts.push(id);
        return capacity ? { outcome: "continued" } : { outcome: "error", message: "rate limited" };
      },
    },
    hasCapacity: async () => capacity,
    policy: RPOLICY,
    now: () => clock,
  });

  await sweeper.onLimitFailure("thr_1", "claude-code");
  await sweeper.onLimitFailure("thr_2", "claude-code");

  for (let i = 0; i < 44; i++) {
    clock = T + i * 120_000;
    const r = await sweeper.sweep("periodic");
    assert.equal(r.stalled, true);
    assert.deepEqual(r.dropped, []);
  }
  assert.deepEqual(attempts, [], "87 minutes cornered without a single wasted attempt");
  assert.equal(records.size, 2, "both threads still tracked and waiting");

  capacity = true;
  clock = T + 44 * 120_000;
  const done = await sweeper.sweep("proactive-switch");
  assert.deepEqual(done.continued.sort(), ["thr_1", "thr_2"]);
  assert.equal(records.size, 0, "nothing left stuck");
});

// ── reconciliation: the store must not depend on one event firing ────────────
//
// The 2026-08-11 outage was ONE upstream null silently disabling the whole
// reactive path, with no alarm, for the plugin's entire life. The trigger is
// fixed, but a store fed only by thread.failed can be switched off the same way
// again. So the watch tick also LOOKS: any errored thread bb never told us
// about is a candidate, confirmed by the same rateLimitRecovery inspection.
//
// The hazard is a loop. An adopted thread that exhausts its attempts is
// dropped, is still `error`, and would be adopted again on the next tick
// forever. So adoption remembers the `updatedAt` it inspected: a dead thread's
// updatedAt never moves, so it is inspected exactly once, and a thread that
// genuinely changes is looked at again.

const listed = (id: string, status: string, updatedAt: number, extra: Partial<ListedThread> = {}): ListedThread =>
  ({ id, status, updatedAt, archivedAt: null, deletedAt: null, ...extra });

test("adoption finds an errored thread bb never announced", () => {
  const plan = planAdoption([listed("thr_lost", "error", 1000)], [], {}, 2000, 3600);
  assert.deepEqual(plan.inspect, ["thr_lost"]);
});

test("adoption ignores threads that are not stopped in error", () => {
  const plan = planAdoption(
    [listed("thr_a", "idle", 1000), listed("thr_b", "active", 1000), listed("thr_c", "starting", 1000)],
    [], {}, 2000, 3600,
  );
  assert.deepEqual(plan.inspect, []);
});

test("adoption ignores archived and deleted threads", () => {
  const plan = planAdoption(
    [listed("thr_arch", "error", 1000, { archivedAt: 1500 }), listed("thr_del", "error", 1000, { deletedAt: 1500 })],
    [], {}, 2000, 3600,
  );
  assert.deepEqual(plan.inspect, []);
});

test("adoption leaves threads the event path already tracked alone", () => {
  const plan = planAdoption([listed("thr_known", "error", 1000)], ["thr_known"], {}, 2000, 3600);
  assert.deepEqual(plan.inspect, []);
});

test("a thread already inspected at this updatedAt is never re-adopted", () => {
  // The drop/re-adopt loop: thr_dead exhausted its attempts and was dropped, so
  // it is untracked AND still error. Without this it would be adopted forever.
  const plan = planAdoption([listed("thr_dead", "error", 1000)], [], { thr_dead: 1000 }, 9000, 3600);
  assert.deepEqual(plan.inspect, []);
});

test("a thread that has genuinely changed since inspection is looked at again", () => {
  const plan = planAdoption([listed("thr_moved", "error", 4000)], [], { thr_moved: 1000 }, 5000, 3600);
  assert.deepEqual(plan.inspect, ["thr_moved"]);
});

test("adoption ignores a thread already past the give-up window", () => {
  // Adopting it would only spend an inspection to drop it on the same tick.
  const plan = planAdoption([listed("thr_old", "error", 1000)], [], {}, 1000 + 3601_000, 3600);
  assert.deepEqual(plan.inspect, []);
});

test("a give-up window of zero means never too old to adopt", () => {
  const plan = planAdoption([listed("thr_ancient", "error", 1)], [], {}, 99_999_999, 0);
  assert.deepEqual(plan.inspect, ["thr_ancient"]);
});

test("inspection memory is pruned to threads that are still errored", () => {
  // Otherwise the map grows forever with every thread that ever failed.
  const plan = planAdoption(
    [listed("thr_still", "error", 1000), listed("thr_recovered", "idle", 1000)],
    [], { thr_still: 1000, thr_recovered: 1000, thr_gone: 1000 }, 2000, 3600,
  );
  assert.deepEqual(plan.retain, { thr_still: 1000 });
});

test("adoption records the updatedAt it inspected, so the next tick skips it", () => {
  const plan = planAdoption([listed("thr_new", "error", 1700)], [], {}, 2000, 3600);
  assert.deepEqual(plan.inspect, ["thr_new"]);
  assert.deepEqual(plan.retain, { thr_new: 1700 });
});

// ---------------------------------------------------------------------------
// MX-210 — usage credits.
//
// Every threshold in this file was chosen when reaching the wall meant work
// STOPPED and the unspent tokens were lost. mgrin enabled Usage credits on ONE
// of four accounts on 2026-08-20, and on that one, past the wall, work
// CONTINUES and it spends money. The axis is no longer "capacity or stall" but
// "free capacity, then paid capacity".
//
// The expensive failure is not the stall. It is parking work on the credit
// account because it never 429s: that converts a free machine into a paid one
// quietly enough that the bill is the first thing to say so. Every ordering
// assertion below guards that direction.
// ---------------------------------------------------------------------------

const paid = (slot: string, fiveHour: number | null, sevenDay: number | null, active = false): AccountUsage =>
  ({ slot, active, fiveHour, sevenDay, credits: "on" });
const free = (slot: string, fiveHour: number | null, sevenDay: number | null, active = false): AccountUsage =>
  ({ slot, active, fiveHour, sevenDay, credits: "off" });

test("a free window outranks a credit account, however roomy the credit account looks", () => {
  // The credit account's own windows are spent, so serving from it costs money.
  // The alternative is nearly out of week and still wins: a 5h window is
  // use-it-or-lose-it and refills in hours, money does not come back.
  assert.equal(pickBest([paid("paid", 100, 100), free("busy", 90, 94)], "x")?.slot, "busy");
});

// ---------------------------------------------------------------------------
// MX-262 — SELECTION NEVER SPENDS MONEY. mgrin's call, 2026-08-22, given
// directly, and he reversed his own first answer inside the same message:
//
//   "The account with billing is an exception — I just needed it one time.
//    That's not the usual case and the system must know it. Usually this will
//    happen only when I really need some capacity when all accounts are
//    exhausted. So in normal operation the system must not prioritize the
//    account with money; it should operate as usual, and if all accounts
//    exhausted all their limits it should wait for limits to be waived. So
//    sorry, my correction, the answer is no — it should not rank this account
//    above."
//
// The record does not carry the "yes". REPORTING IS UNCHANGED AND DISAGREES ON
// PURPOSE: capacityVerdict still answers "paid-only" and `bb accounts outage`
// still says the machine can serve, because it can. Reporting answers what is
// POSSIBLE, selection answers what is POLICY, and reconciling one to the other
// silently restores the behaviour he overruled.
// ---------------------------------------------------------------------------

test("a spent credit account is NOT a destination — the machine waits instead", () => {
  // This asserted the OPPOSITE from MX-210 until 2026-08-22 ("a spent credit
  // account is a candidate at all"), which was right for the question MX-210
  // asked. mgrin answered the next question differently.
  assert.equal(pickBest([paid("paid", 100, 100)], "x"), null);
});

test("can serve is not a reason to select", () => {
  // THE PERSUASIVE CASE. A maintainer will want this account picked because
  // "it can serve, and refusing to work when work is possible looks broken" —
  // and it CAN serve: credits are on, so it answers rather than 429ing, and
  // capacityVerdict says so on the very next line. Billing is an exception
  // mgrin invokes (`bb accounts switch <slot>`, `claude-acct use <slot>`), not
  // a tier the machine spends on his behalf. Argue with his paragraph above
  // before deleting this.
  const board = [free("out", 0, 100, true), paid("credit", 100, 12)];
  assert.equal(pickBest(board, "out"), null);
  assert.equal(capacityVerdict(board), "paid-only");
});

test("a spent account without credits stays excluded", () => {
  assert.equal(pickBest([free("done", 100, 100)], "x"), null);
});

test("UNKNOWN credit state is never promoted to a paid candidate", () => {
  // `credits` absent = the poll never said. Not knowing is not a licence to spend.
  assert.equal(pickBest([acct("dunno", 100, 100)], "x"), null);
});

test("an exact tie breaks AWAY from the credit account", () => {
  // Equally roomy is not equally safe: work parked on the credit account starts
  // billing the moment its window closes, up to a poll interval before anything
  // notices. "a-paid" sorts first alphabetically, so only the tie-break can
  // make "z-free" win.
  assert.equal(pickBest([paid("a-paid", 30, 30), free("z-free", 30, 30)], "x")?.slot, "z-free");
});

test("a credit account whose own window is untouched is still FREE capacity", () => {
  // "Credits rank last" is about paid capacity, not about the account. Refusing
  // to spend an untouched 5h window would be the v3 stranding mistake in a new
  // costume; money is only spent past that window's wall.
  assert.equal(pickBest([paid("paid", 0, 0), free("busy", 60, 60)], "x")?.slot, "paid");
});

test("a walled machine WAITS rather than moving onto credits", () => {
  // The live state MX-210 shipped the paid fallback for (2026-08-20 13:19Z):
  // three accounts at 7d 100% and one at 5h 100% / 7d 12% with credits on.
  // It asserted `action === "urgent"` onto "credit" until 2026-08-22.
  const decision = decideSwitch(
    [free("out-a", 0, 100, true), free("out-b", 0, 100), paid("credit", 100, 12)],
    POLICY,
    Infinity,
  );
  assert.equal(decision.action, "none");
  assert.match(decision.reason, /WAITING/);
});

test("the wait names the slot it declined and how to take it deliberately", () => {
  // Not switching is the INTENDED outcome, not a failure to find a candidate,
  // and the two must not read alike: "no eligible alternative slot" sends the
  // reader hunting a broken poll. This one says what it refused and what the
  // human can do about it.
  const decision = decideSwitch(
    [free("out-a", 0, 100, true), paid("credit", 100, 12)],
    POLICY,
    Infinity,
  );
  assert.match(decision.reason, /credit/);
  assert.match(decision.reason, /bb accounts switch credit/);
});

test("nothing available at all still reads as nothing available", () => {
  // The refusal above is about DECLINING paid capacity. With no credits
  // anywhere there is nothing to decline, and saying "WAITING: ... would BILL"
  // would be a claim about money that is not true here.
  const decision = decideSwitch([free("out-a", 0, 100, true), free("out-b", 0, 100)], POLICY, Infinity);
  assert.equal(decision.action, "none");
  assert.doesNotMatch(decision.reason, /BILL/);
});

test("it does NOT move onto credits while the active slot still has free window", () => {
  // Active trips at 97 with no free alternative and the credit account sitting
  // there never 429ing. Moving now strands three points of a use-it-or-lose-it
  // window AND starts spending. Stay and wall.
  //
  // Since MX-262 the SECOND half of this is also true: once the active slot is
  // genuinely spent it still does not move — it waits. This case is now the
  // narrower one, and it is kept because the stranding argument stands on its
  // own and would survive a reversal of mgrin's decision.
  const decision = decideSwitch(
    [free("burning", 97, 20, true), free("out", 0, 100), paid("credit", 100, 12)],
    POLICY,
    Infinity,
  );
  assert.equal(decision.action, "none");
  assert.match(decision.reason, /free window/);
});

test("an unreadable active slot never authorises spending", () => {
  // A failed poll must not be the thing that opens a bill.
  const decision = decideSwitch(
    [{ slot: "active-unknown", active: true, fiveHour: null, sevenDay: 100 }, paid("credit", 100, 12)],
    POLICY,
    Infinity,
  );
  assert.equal(decision.action, "none");
});

test("the credit account is left as soon as a free window reopens", () => {
  // Credits are a last resort, not a place to park. The active slot here never
  // 429s, so nothing but this rule moves work back onto free capacity.
  const decision = decideSwitch([paid("credit", 100, 12, true), free("refilled", 0, 40)], POLICY, Infinity);
  assert.equal(decision.action === "urgent" && decision.to, "refilled");
});

test("SPREAD never spends money — an optimization is not a reason to bill", () => {
  // Active is merely WORSE, not walled, and the only roomier slot is paid.
  //
  // Reaching this needs weeklyAt below the wall, and that is the whole point of
  // testing it: at weeklyAt 100 a tier-1 slot always scores >= 100, so no
  // spread gap can ever open and the guard is unreachable. weeklyAt is a
  // SETTING, so "unreachable today" is one config change from reachable — and
  // the config change would arrive with no test to notice. Here the gap is
  // 90 - 60 = 30, over the 25-point margin, so spread would fire onto paid
  // capacity without the guard.
  //
  // MX-262 moved the guard into `pickBest`, which no longer offers a paid slot
  // to ANY caller, so the dedicated `spread declined:` branch is gone rather
  // than duplicated. The claim this test exists for is unchanged and still
  // checked: no switch, and the reason names the credit account rather than
  // pretending nothing was there.
  const policy: SwitchPolicy = { ...POLICY, weeklyAt: 50 };
  const decision = decideSwitch([free("busy", 90, 10, true), paid("credit", 0, 60)], policy, Infinity);
  assert.equal(decision.action, "none", `spread billed money as an optimization: ${decision.reason}`);
  assert.match(decision.reason, /credit/);
  assert.match(decision.reason, /never auto-selected/);
});

test("capacityVerdict separates an outage from a machine with only paid capacity left", () => {
  assert.equal(capacityVerdict([free("a", 10, 10)]), "free");
  assert.equal(capacityVerdict([free("out", 0, 100), paid("credit", 100, 100)]), "paid-only");
  assert.equal(capacityVerdict([free("out-a", 100, 100), free("out-b", 0, 100)]), "none");
});

test("capacityVerdict says UNKNOWN rather than none when an account could not be read", () => {
  // A poll that failed knows nothing. Counting it as exhausted is the silent
  // downgrade every other instrument here refuses to make.
  assert.equal(capacityVerdict([free("out", 0, 100), acct("broken", null, null)]), "unknown");
  assert.equal(capacityVerdict([]), "unknown");
});

test("a known paid path beats an unknown, because it is an answer", () => {
  assert.equal(capacityVerdict([acct("broken", null, null), paid("credit", 100, 100)]), "paid-only");
});
