// Can this machine serve AT ALL, and when does the first free window return?
//
// Those are two questions, and treating them as one is what MX-218 fixed. The
// verdict is the first (`cannotServe`); the second is a fact about money and
// waiting that keeps its own field (`allFreeWindowsSpent`) and its own ETA.
//
// This exists because of one asymmetry: the agent cannot announce its own
// outage. If all accounts are walled, the thing that would post the message is
// the thing that cannot run — so the question has to be answerable by a
// SCHEDULED component that is already running anyway (the 2-minute `watch`
// tick), and the answer has to be sitting there, cheap to read, for whoever
// decides to speak. This module owns the judgement; it does not own the
// speaking, and deliberately knows nothing about any channel.
//
// The consumer is a message to humans, which changes what "unknown" costs. A
// confidently wrong "back around 14:30" is worse than saying nothing, so every
// path here fails towards silence: unknown utilisation is not an outage, a
// stale poll is not an outage, one read is not an outage, and a reset time that
// was not READ is never estimated.
//
// Pure by convention, like the rest of analytics/: server.ts does the I/O.

import { DEFAULT_WEEKLY_AT, usableHeadroom, type PlacementAccount } from "./placement.ts";
import type { CapacityVerdict } from "../lib.ts";

/**
 * The 5-hour wall. Note this is NOT `switchAt` (97): that is the point at which
 * the plugin proactively moves OFF an account, and an account at 98% still
 * answers requests. Exhausted means the requests fail.
 */
export const EXHAUSTED_AT = 100;

/** Distinct polls that must agree before an outage is worth announcing. */
export const DEFAULT_CONFIRM_POLLS = 3;

export interface OutageAccount extends PlacementAccount {
  /** ISO-8601 from the poller, or null — which it always is when util is 0. */
  fiveResetsAt: string | null;
  sevenResetsAt: string | null;
}

export type Window = "fiveHour" | "sevenDay";

export interface AccountOutage {
  slot: string;
  /** True when at least one window is at its wall, so the account cannot serve. */
  exhausted: boolean;
  /** Which windows are at a wall. Empty when the account still works. */
  binding: Window[];
  /**
   * ISO-8601 (ms precision, UTC) when this account starts working again, or
   * null. Null means EITHER "usable now" (exhausted === false) OR "unknown"
   * (exhausted === true) — read `exhausted` to tell them apart.
   */
  usableAt: string | null;
}

export type UnknownReason = "stale" | "no-reset-time" | null;

export interface OutageVerdict {
  /**
   * THE OUTAGE. No account can serve a request by ANY means — no free window
   * anywhere and no paid credits behind the walls (MX-218; mgrin, 2026-08-21).
   *
   * Read straight off `capacity === "none"`, which is the same predicate the
   * recovery sweeper already gates on (`anyAccountHasCapacity`), so the two
   * cannot drift into disagreeing about whether this machine is working.
   */
  cannotServe: boolean;
  /**
   * Every account has spent its free window. Still true, still useful, and no
   * longer an outage on its own: with credits on it is a fact about MONEY, not
   * about availability. This was `allExhausted` until MX-218 — renamed rather
   * than redefined, so a consumer that still reads the old name gets
   * `undefined` instead of a boolean that quietly means something else.
   */
  allFreeWindowsSpent: boolean;
  /** What the machine can serve, as handed in — echoed so one read answers all. */
  capacity: CapacityVerdict;
  /** ISO-8601 of the first moment any account works again; null = UNKNOWN. */
  earliestUsableAt: string | null;
  earliestUsableSlot: string | null;
  /** Why there is no timestamp, when every free window is spent but the ETA is not readable. */
  unknownReason: UnknownReason;
  /** One line, safe to read aloud. */
  reason: string;
  accounts: AccountOutage[];
}

/** Date.parse, but "not a time I can trust" and "no time" are the same answer. */
function parseReset(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * One account: is it walled, and when does it clear?
 *
 * The time it becomes usable is the LATEST reset among the windows that are
 * CURRENTLY at a wall — an account at 5h 100 / 7d 79 clears at the 5h reset
 * even though its 7d reset is days away, and an account walled on both is not
 * back until the later of the two.
 *
 * Two null-handling rules pull in opposite directions and both are deliberate:
 *
 *  - A null UTILISATION never makes an account exhausted. usableHeadroom reads
 *    an unknown window as 100, which is correct for placement (never route work
 *    at a window you cannot see) and exactly backwards here, where it would
 *    manufacture an outage message out of a failed poll. So unknown is coerced
 *    to 0 before asking usableHeadroom — the min-of-both-windows rule is reused,
 *    only the direction of the doubt is flipped.
 *  - A null RESET on a binding window makes the time UNKNOWN rather than
 *    absent. `resetsAt` is null whenever util is 0, so a naive minimum over
 *    every resetsAt would sort those nulls first and publish "back now"; a
 *    binding window with no reset is a real gap and is reported as one.
 */
export function accountOutage(a: OutageAccount, weeklyAt: number = DEFAULT_WEEKLY_AT): AccountOutage {
  const known = { ...a, fiveUtil: a.fiveUtil ?? 0, sevenUtil: a.sevenUtil ?? 0 };
  const exhausted = usableHeadroom(known, EXHAUSTED_AT, weeklyAt) <= 0;
  if (!exhausted) return { slot: a.slot, exhausted: false, binding: [], usableAt: null };

  const binding: Window[] = [];
  if (known.fiveUtil >= EXHAUSTED_AT) binding.push("fiveHour");
  if (known.sevenUtil >= weeklyAt) binding.push("sevenDay");

  const resets = binding.map((w) => parseReset(w === "fiveHour" ? a.fiveResetsAt : a.sevenResetsAt));
  const usableAt = resets.some((t) => t === null)
    ? null
    : new Date(Math.max(...(resets as number[]))).toISOString();
  return { slot: a.slot, exhausted: true, binding, usableAt };
}

/**
 * The first moment ANY exhausted account works again.
 *
 * All-or-nothing on purpose: if one walled account's reset time could not be
 * read, the true minimum may be earlier than every time we can see, so the
 * answer is UNKNOWN rather than the minimum of the rest. Accounts that are not
 * exhausted contribute nothing — they are usable now, which the caller already
 * knows from the predicate.
 */
export function earliestUsable(
  accounts: readonly OutageAccount[],
  weeklyAt: number = DEFAULT_WEEKLY_AT,
): { at: string | null; slot: string | null; unknownReason: UnknownReason } {
  const walled = accounts.map((a) => accountOutage(a, weeklyAt)).filter((o) => o.exhausted);
  if (walled.length === 0) return { at: null, slot: null, unknownReason: null };
  if (walled.some((o) => o.usableAt === null)) return { at: null, slot: null, unknownReason: "no-reset-time" };
  const first = walled.reduce((best, o) => (o.usableAt! < best.usableAt! ? o : best));
  return { at: first.usableAt, slot: first.slot, unknownReason: null };
}

/**
 * The predicate, over the whole fleet.
 *
 * WHAT AN OUTAGE MEANS (MX-218; mgrin's call, 2026-08-21): the machine cannot
 * serve AT ALL. It used to mean "no free window is left anywhere", which is a
 * different statement the moment credits are on — and while they are on, a
 * machine that bills happily was reporting itself dark. The free-window fact
 * did not stop being true or useful, so it keeps its own field
 * (`allFreeWindowsSpent`) and its own ETA; it just stopped being the verdict.
 *
 * `capacity` is REQUIRED rather than defaulted, and that is the point: this
 * question cannot be answered without knowing whether there is a paid path, so
 * a caller must say. A default would let the old answer come back silently.
 *
 * `stale` is a hard gate, not a caveat: the poller's cache going quiet looks
 * exactly like every account being at 100 if you only read utilisations, and
 * announcing an outage because a LaunchAgent died would be a lie about the
 * machine. An empty account list is likewise an absence of data, not an outage.
 */
export function assessOutage(
  accounts: readonly OutageAccount[],
  opts: { weeklyAt?: number; stale?: boolean; capacity: CapacityVerdict },
): OutageVerdict {
  const weeklyAt = opts.weeklyAt ?? DEFAULT_WEEKLY_AT;
  const per = accounts.map((a) => accountOutage(a, weeklyAt));

  if (opts.stale) {
    return {
      cannotServe: false,
      allFreeWindowsSpent: false,
      capacity: "unknown",
      earliestUsableAt: null,
      earliestUsableSlot: null,
      unknownReason: "stale",
      reason: "usage cache is stale — cannot tell whether the accounts are exhausted",
      accounts: per,
    };
  }
  if (per.length === 0) {
    return {
      cannotServe: false,
      allFreeWindowsSpent: false,
      capacity: "unknown",
      earliestUsableAt: null,
      earliestUsableSlot: null,
      unknownReason: null,
      reason: "no accounts in the usage cache",
      accounts: per,
    };
  }
  const usable = per.filter((o) => !o.exhausted);
  if (usable.length > 0) {
    return {
      cannotServe: false,
      allFreeWindowsSpent: false,
      capacity: opts.capacity,
      earliestUsableAt: null,
      earliestUsableSlot: null,
      unknownReason: null,
      reason: `${usable.length} of ${per.length} account(s) still have headroom (${usable.map((o) => o.slot).join(", ")})`,
      accounts: per,
    };
  }
  const first = earliestUsable(accounts, weeklyAt);
  // Two clauses, kept apart on purpose: the first is about MONEY (can anything
  // serve, and does it bill), the second about the free window coming back.
  // Collapsing them is how "no free window" came to read as "there is nothing".
  const money =
    opts.capacity === "none"
      ? "no paid credits are open, so nothing can serve"
      : opts.capacity === "paid-only"
        ? "paid credits are open, so work still runs and it BILLS"
        : "cannot tell whether paid credits are open on any of them";
  const back =
    first.at === null
      ? "when the first free window returns is unknown (no reset time on a binding window)"
      : `${first.slot}'s free window returns at ${first.at}`;
  return {
    cannotServe: opts.capacity === "none",
    allFreeWindowsSpent: true,
    capacity: opts.capacity,
    earliestUsableAt: first.at,
    earliestUsableSlot: first.slot,
    unknownReason: first.unknownReason,
    reason: `all ${per.length} account(s) have spent their free window; ${money}; ${back}`,
    accounts: per,
  };
}

/**
 * The headline and the exit code, from ONE place.
 *
 * The ticket's requirement is that the headline, the boolean and the exit
 * status give the same answer, so that reading any one of them is safe. They
 * agree here because one function emits two of them off the verdict that
 * carries the third — the previous shape had the exit expression written out
 * twice and the headline a fourth time, which is a contract kept in step by
 * hand.
 *
 * THE EXIT CODES, after MX-218:
 *   0  the machine cannot serve at all, confirmed over N distinct non-stale
 *      polls. The ONLY code that means "stop" — `if bb accounts outage; then`
 *      still speaks on 0 alone.
 *   1  the machine can serve. Includes PAID-ONLY, which runs and bills; the
 *      headline says so, because exit 1 must not read as "all is well".
 *   2  cannot tell — a stale poll, an account that could not be read, or an
 *      outage too young to have been confirmed. Both flavours of doubt fall
 *      here, and doubt is never 1.
 */
export function outageSignals(
  v: Pick<OutageVerdict, "cannotServe" | "capacity" | "unknownReason">,
  confirmed: boolean,
): { headline: string; exitCode: 0 | 1 | 2 } {
  if (v.cannotServe) {
    return confirmed
      ? { headline: "CANNOT SERVE — every account is walled and no credits are open", exitCode: 0 }
      : { headline: "cannot serve, not yet confirmed", exitCode: 2 };
  }
  if (v.unknownReason === "stale") return { headline: "unknown (stale poll)", exitCode: 2 };
  if (v.capacity === "unknown") return { headline: "unknown (an account could not be read)", exitCode: 2 };
  if (v.capacity === "paid-only") return { headline: "accounts available — PAID ONLY, work BILLS", exitCode: 1 };
  return { headline: "accounts available", exitCode: 1 };
}

/**
 * How many consecutive polls have agreed, carried across watch ticks.
 *
 * `lastPolledAt` is the load-bearing field. The watch tick fires every 120s and
 * the poller writes every 180s, so two or three ticks routinely read the SAME
 * poll — counting those would let ONE read satisfy "three consecutive polls",
 * which is precisely the single-read conclusion this is meant to prevent.
 */
export interface OutageStreak {
  consecutive: number;
  /** polledAt of the first poll in the current run, for "out since". */
  sincePolledAt: number | null;
  /** polledAt of the most recent poll counted, to dedupe re-reads. */
  lastPolledAt: number | null;
}

export const EMPTY_STREAK: OutageStreak = { consecutive: 0, sincePolledAt: null, lastPolledAt: null };

export function advanceStreak(
  prev: OutageStreak | null,
  verdict: Pick<OutageVerdict, "cannotServe">,
  polledAt: number | null,
): OutageStreak {
  // A poll with no timestamp cannot be shown to be a NEW poll, so it cannot be
  // evidence of persistence. Break the run rather than count it.
  if (!verdict.cannotServe || polledAt === null) return EMPTY_STREAK;
  const last = prev ?? EMPTY_STREAK;
  if (last.lastPolledAt !== null && polledAt <= last.lastPolledAt) return last;
  return {
    consecutive: last.consecutive + 1,
    sincePolledAt: last.sincePolledAt ?? polledAt,
    lastPolledAt: polledAt,
  };
}

/**
 * The one question a would-be announcer should ask. Both halves are required:
 * the CURRENT poll must show the outage (a streak alone is history, and an
 * account can come back between two ticks) and enough distinct polls must have
 * agreed.
 */
export function isConfirmed(
  verdict: Pick<OutageVerdict, "cannotServe">,
  streak: OutageStreak | null,
  requiredPolls: number = DEFAULT_CONFIRM_POLLS,
): boolean {
  return verdict.cannotServe && (streak?.consecutive ?? 0) >= Math.max(1, requiredPolls);
}
