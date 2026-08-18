import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accountOutage,
  advanceStreak,
  assessOutage,
  earliestUsable,
  EMPTY_STREAK,
  isConfirmed,
  type OutageAccount,
} from "./outage.ts";

const acct = (over: Partial<OutageAccount> & { slot: string }): OutageAccount => ({
  fiveUtil: 0,
  sevenUtil: 0,
  active: false,
  fiveResetsAt: null,
  sevenResetsAt: null,
  ...over,
});

// The real fleet at 2026-08-18 09:57, from `bb accounts status --json`. Three of
// four accounts are at a wall and one is not, so this is the fleet the predicate
// must say NO to.
const REAL: OutageAccount[] = [
  {
    slot: "mr6r1n_gmail.com",
    fiveUtil: 100,
    sevenUtil: 79,
    active: false,
    fiveResetsAt: "2026-08-18T10:19:59.728152+00:00",
    sevenResetsAt: "2026-08-24T03:59:59.728175+00:00",
  },
  {
    slot: "nikita_scani.xyz",
    fiveUtil: 0,
    sevenUtil: 100,
    active: false,
    fiveResetsAt: null,
    sevenResetsAt: "2026-08-20T11:00:00.318601+00:00",
  },
  {
    slot: "nikita_withflare.xyz",
    fiveUtil: 92,
    sevenUtil: 29,
    active: true,
    fiveResetsAt: "2026-08-18T13:29:59.737449+00:00",
    sevenResetsAt: "2026-08-25T00:59:59.737473+00:00",
  },
  {
    slot: "steve_scani.xyz",
    fiveUtil: 0,
    sevenUtil: 100,
    active: false,
    fiveResetsAt: null,
    sevenResetsAt: "2026-08-20T23:00:00.274652+00:00",
  },
];

// ── per-account: which window binds, and when it clears ──────────────────────

test("an account walled on 5h only clears at its 5h reset, not its 7d one", () => {
  const o = accountOutage(REAL[0]!);
  assert.equal(o.exhausted, true);
  assert.deepEqual(o.binding, ["fiveHour"]);
  assert.equal(o.usableAt, "2026-08-18T10:19:59.728Z");
});

// The trap the ticket names: resetsAt is null whenever util is 0, and a naive
// min over every resetsAt would sort that null first and publish "back now".
test("an account walled on 7d only clears at its 7d reset, ignoring a null 5h reset", () => {
  const o = accountOutage(REAL[1]!);
  assert.equal(o.exhausted, true);
  assert.deepEqual(o.binding, ["sevenDay"]);
  assert.equal(o.usableAt, "2026-08-20T11:00:00.318Z");
});

test("an account walled on BOTH windows clears at the LATER of the two resets", () => {
  const o = accountOutage(
    acct({
      slot: "both",
      fiveUtil: 100,
      sevenUtil: 100,
      fiveResetsAt: "2026-08-18T10:19:59+00:00",
      sevenResetsAt: "2026-08-20T11:00:00+00:00",
    }),
  );
  assert.deepEqual(o.binding, ["fiveHour", "sevenDay"]);
  assert.equal(o.usableAt, "2026-08-20T11:00:00.000Z");
});

test("an account with headroom is not exhausted and has no usable-at time", () => {
  const o = accountOutage(REAL[2]!);
  assert.equal(o.exhausted, false);
  assert.deepEqual(o.binding, []);
  assert.equal(o.usableAt, null);
});

test("99% is not exhausted — the wall is 100, not the proactive switch threshold", () => {
  assert.equal(accountOutage(acct({ slot: "x", fiveUtil: 99, sevenUtil: 99 })).exhausted, false);
});

// An unreadable poll is not an outage. usableHeadroom reads null as 100, which
// is right for placement and exactly backwards here.
test("a null utilization never on its own makes an account exhausted", () => {
  const o = accountOutage(acct({ slot: "unknown", fiveUtil: null, sevenUtil: null }));
  assert.equal(o.exhausted, false);
});

test("a null 5h is still exhausted when the 7d window is at the wall", () => {
  const o = accountOutage(
    acct({ slot: "x", fiveUtil: null, sevenUtil: 100, sevenResetsAt: "2026-08-20T11:00:00+00:00" }),
  );
  assert.equal(o.exhausted, true);
  assert.equal(o.usableAt, "2026-08-20T11:00:00.000Z");
});

test("a weeklyAt below 100 makes a 7d-96 account exhausted, matching the destination cap", () => {
  const a = acct({ slot: "x", sevenUtil: 96, sevenResetsAt: "2026-08-20T11:00:00+00:00" });
  assert.equal(accountOutage(a).exhausted, false);
  assert.equal(accountOutage(a, 95).exhausted, true);
});

test("a missing reset on the binding window makes the account's usable time UNKNOWN", () => {
  const o = accountOutage(acct({ slot: "x", fiveUtil: 100, fiveResetsAt: null }));
  assert.equal(o.exhausted, true);
  assert.equal(o.usableAt, null);
});

test("an unparseable reset is UNKNOWN, never a guess", () => {
  const o = accountOutage(acct({ slot: "x", fiveUtil: 100, fiveResetsAt: "soon-ish" }));
  assert.equal(o.exhausted, true);
  assert.equal(o.usableAt, null);
});

// ── the predicate ────────────────────────────────────────────────────────────

test("the real fleet of 2026-08-18 is NOT all-exhausted — one account had room", () => {
  const v = assessOutage(REAL);
  assert.equal(v.allExhausted, false);
  assert.equal(v.earliestUsableAt, null);
});

test("all-exhausted is true only when every account is walled on its binding window", () => {
  const walled = REAL.map((a) =>
    a.slot === "nikita_withflare.xyz"
      ? { ...a, fiveUtil: 100 }
      : a,
  );
  const v = assessOutage(walled);
  assert.equal(v.allExhausted, true);
});

test("one unreadable account suppresses the outage rather than completing it", () => {
  const walled = REAL.map((a) =>
    a.slot === "nikita_withflare.xyz" ? { ...a, fiveUtil: null, sevenUtil: null } : a,
  );
  assert.equal(assessOutage(walled).allExhausted, false);
});

test("stale data can never satisfy the predicate", () => {
  const walled = REAL.map((a) => (a.slot === "nikita_withflare.xyz" ? { ...a, fiveUtil: 100 } : a));
  const v = assessOutage(walled, { stale: true });
  assert.equal(v.allExhausted, false);
  assert.equal(v.earliestUsableAt, null);
  assert.equal(v.unknownReason, "stale");
});

test("an empty account list is not an outage — it is an absence of data", () => {
  assert.equal(assessOutage([]).allExhausted, false);
});

// ── earliest usable ──────────────────────────────────────────────────────────

test("earliest-usable is the MINIMUM across the exhausted accounts", () => {
  const walled = REAL.map((a) => (a.slot === "nikita_withflare.xyz" ? { ...a, fiveUtil: 100 } : a));
  const v = assessOutage(walled);
  // mr6r1n clears at 10:19 today; the others not until 13:29 today / 20 Aug.
  assert.equal(v.earliestUsableAt, "2026-08-18T10:19:59.728Z");
  assert.equal(v.earliestUsableSlot, "mr6r1n_gmail.com");
  assert.equal(v.unknownReason, null);
});

test("one missing reset makes the whole earliest-usable UNKNOWN, not the min of the rest", () => {
  const walled = REAL.map((a) =>
    a.slot === "nikita_withflare.xyz"
      ? { ...a, fiveUtil: 100, fiveResetsAt: null }
      : a,
  );
  const v = assessOutage(walled);
  assert.equal(v.allExhausted, true);
  assert.equal(v.earliestUsableAt, null);
  assert.equal(v.unknownReason, "no-reset-time");
});

// The documented contract for "no account has a usable reset time": the outage
// still stands and is worth announcing; only the ETA is withheld.
test("when NO account has a reset time the outage still holds and the time is UNKNOWN", () => {
  const blind = REAL.map((a) => ({ ...a, fiveUtil: 100, fiveResetsAt: null, sevenResetsAt: null }));
  const v = assessOutage(blind);
  assert.equal(v.allExhausted, true);
  assert.equal(v.earliestUsableAt, null);
  assert.equal(v.unknownReason, "no-reset-time");
  assert.match(v.reason, /unknown/i);
});

test("earliestUsable has nothing to report when no account is walled", () => {
  const roomy = REAL.map((a) => ({ ...a, fiveUtil: 10, sevenUtil: 10 }));
  assert.deepEqual(earliestUsable(roomy), { at: null, slot: null, unknownReason: null });
});

// The cornered notification wants this even when the fleet is not fully out:
// the accounts with headroom are usable NOW and contribute no waiting time.
test("earliestUsable answers over the walled accounts only, ignoring the roomy ones", () => {
  const r = earliestUsable(REAL);
  assert.equal(r.slot, "mr6r1n_gmail.com");
  assert.equal(r.at, "2026-08-18T10:19:59.728Z");
});

// ── the streak: N consecutive DISTINCT polls ─────────────────────────────────

// The watch tick runs every 120s and the poller writes every 180s, so two or
// three ticks routinely read the SAME poll. Counting those would let one read
// satisfy "3 consecutive polls", which is the failure the ticket forbids.
test("the streak does not advance when the watch re-reads the same poll", () => {
  const yes = { allExhausted: true } as ReturnType<typeof assessOutage>;
  const s1 = advanceStreak(EMPTY_STREAK, yes, 1787045956);
  const s2 = advanceStreak(s1, yes, 1787045956);
  assert.equal(s1.consecutive, 1);
  assert.equal(s2.consecutive, 1);
});

test("the streak advances once per distinct poll", () => {
  const yes = { allExhausted: true } as ReturnType<typeof assessOutage>;
  let s = advanceStreak(EMPTY_STREAK, yes, 100);
  s = advanceStreak(s, yes, 280);
  s = advanceStreak(s, yes, 460);
  assert.equal(s.consecutive, 3);
  assert.equal(s.sincePolledAt, 100);
});

test("one account coming back resets the streak to zero", () => {
  const yes = { allExhausted: true } as ReturnType<typeof assessOutage>;
  const no = { allExhausted: false } as ReturnType<typeof assessOutage>;
  let s = advanceStreak(EMPTY_STREAK, yes, 100);
  s = advanceStreak(s, yes, 280);
  s = advanceStreak(s, no, 460);
  assert.equal(s.consecutive, 0);
  assert.equal(s.sincePolledAt, null);
});

test("a null polledAt resets the streak — a poll with no timestamp is not evidence", () => {
  const yes = { allExhausted: true } as ReturnType<typeof assessOutage>;
  let s = advanceStreak(EMPTY_STREAK, yes, 100);
  s = advanceStreak(s, yes, null);
  assert.equal(s.consecutive, 0);
});

test("confirmed only after the required number of distinct polls", () => {
  const yes = { allExhausted: true } as ReturnType<typeof assessOutage>;
  let s = advanceStreak(EMPTY_STREAK, yes, 100);
  s = advanceStreak(s, yes, 280);
  assert.equal(isConfirmed(yes, s, 3), false);
  s = advanceStreak(s, yes, 460);
  assert.equal(isConfirmed(yes, s, 3), true);
});

test("a long streak cannot confirm an outage the current poll does not show", () => {
  const yes = { allExhausted: true } as ReturnType<typeof assessOutage>;
  const no = { allExhausted: false } as ReturnType<typeof assessOutage>;
  let s = advanceStreak(EMPTY_STREAK, yes, 100);
  s = advanceStreak(s, yes, 280);
  s = advanceStreak(s, yes, 460);
  assert.equal(isConfirmed(no, s, 3), false);
});
