// The switch decision, as a pure function.
//
// It used to live inside the 2-minute cron callback, tangled with kv reads and
// an execFile — which meant the one piece of logic that decides, unattended and
// all night, which Claude account your work bills to could not be exercised at
// all. Everything I/O-shaped stays in server.ts; everything judgement-shaped is
// here, where `node --test` can ask it awkward questions.

/**
 * Whether an account has PAID capacity behind its wall (MX-210).
 *
 * Three-valued for the same reason every other instrument here is: a poll that
 * failed knows nothing, and reading that silence as "no credits" is the silent
 * downgrade to "exhausted" this plugin exists to avoid. It cuts the safe way in
 * both directions — "unknown" never authorises spending money (pickBest) and
 * never declares a machine walled (capacityVerdict).
 *
 * "off" also covers credits enabled but spend-limit reached: that is a KNOWN
 * absence of paid capacity, which is not the same as not knowing.
 */
export type CreditState = "on" | "off" | "unknown";

/** What an account has actually spent, in MAJOR currency units. */
export interface CreditSpend {
  used: number | null;
  limit: number | null;
  /** Percent of the monthly cap, as the endpoint itself reports it. */
  util: number | null;
  currency: string | null;
}

export interface AccountUsage {
  slot: string;
  active: boolean;
  /** Percent utilization of the rolling 5-hour window, null when unknown. */
  fiveHour: number | null;
  /** Percent utilization of the 7-day window, null when unknown. */
  sevenDay: number | null;
  /** Absent means the caller did not look, which is "unknown", never "off". */
  credits?: CreditState;
  creditSpend?: CreditSpend | null;
}

/** The 5-hour wall. Unlike weeklyAt this is not a policy knob — at 100 the
 *  window is simply gone until it rolls, and no threshold changes that. */
const FIVE_WALL = 100;

/**
 * Does this account have UNPAID capacity right now? `null` = cannot tell.
 *
 * Deliberately the wall on both windows rather than the switching thresholds:
 * this answers "is there anything left", not "should we move".
 */
export function hasFreeWindow(a: AccountUsage, weeklyAt: number = WEEKLY_AT): boolean | null {
  if (a.fiveHour === null) return null;
  if (a.fiveHour >= FIVE_WALL) return false;
  return (a.sevenDay ?? 0) < weeklyAt;
}

/**
 * Where a slot sits in the destination order: 0 = free capacity, 1 = paid
 * capacity (credits ON behind a spent window), null = not a destination.
 *
 * Tier 1 exists so that "only paid capacity left" stops rendering as "nothing
 * left", and it ranks BELOW every tier 0 — that ordering is the whole point. A
 * ranking that let the credit account win because it never 429s would convert a
 * free machine into a paid one, and the bill would be the only thing to say so.
 */
export function candidateTier(a: AccountUsage, weeklyAt: number = WEEKLY_AT): 0 | 1 | null {
  const free = hasFreeWindow(a, weeklyAt);
  if (free === null) return null;
  if (free) return 0;
  return a.credits === "on" ? 1 : null;
}

export type CapacityVerdict = "free" | "paid-only" | "none" | "unknown";

/**
 * What this machine can serve: free capacity, paid capacity only, nothing, or
 * not knowable.
 *
 * "no capacity" and "only paid capacity left" used to be one boolean, which is
 * how a machine with an open (paid) path reported itself walled. They want
 * opposite responses: one is an outage to wait out, the other is a decision
 * about money.
 *
 * Ordering is deliberate. A known free window beats everything. A known paid
 * path beats an unknown, because it is an answer. "none" is claimed only when
 * every account was actually read — one unreadable account leaves the whole
 * verdict UNKNOWN rather than counting itself as exhausted.
 */
export function capacityVerdict(accounts: AccountUsage[], weeklyAt: number = WEEKLY_AT): CapacityVerdict {
  if (accounts.length === 0) return "unknown";
  let paid = false;
  let blind = false;
  for (const a of accounts) {
    const free = hasFreeWindow(a, weeklyAt);
    if (free) return "free";
    if (free === null || (a.credits ?? "unknown") === "unknown") blind = true;
    if (a.credits === "on") paid = true;
  }
  if (paid) return "paid-only";
  return blind ? "unknown" : "none";
}

export interface SwitchPolicy {
  /** 5h % at which the active slot must be abandoned before it 429s. */
  switchAt: number;
  /** Points of max(5h,7d) another slot must be roomier by to switch early. 0 disables. */
  spreadMargin: number;
  /** Seconds since the last switch below which no switch may happen at all. */
  cooldownSec: number;
  /** Seconds since the last switch below which only an URGENT switch may happen. */
  spreadCooldownSec: number;
  /**
   * 7d % at which the active slot must be abandoned, and the cap on which slots
   * may be switched INTO. This is the WALL (100), not a safety margin.
   *
   * It was 95 until 2026-08-13, which cost capacity at both ends: an account was
   * abandoned with 5% of its week unspent, and — worse — no account above 95 was
   * an eligible destination, so once every slot drifted past it pickBest returned
   * null, nothing switched, and threads waited on tokens that demonstrably
   * existed (observed live at 98/99/95). Unlike a 5-hour window, a 7-day one is
   * the scarce resource; leaving a slice of it unspent on every account in
   * rotation is the one thing this plugin must not do.
   *
   * 100 is safe as a TRIGGER because at 100 there is nothing left to strand, and
   * the reactive path (isLimitFailure -> switch -> resume) already covers the
   * threads that hit the wall between two polls.
   */
  weeklyAt?: number;
  /** Seconds ahead the burn rate is projected. Matches the poller's interval. */
  pollIntervalSec?: number;
}

const WEEKLY_AT = 100;
const POLL_INTERVAL_S = 180;

/** The previous 5h reading for the SAME slot, for measuring a burn rate. */
export interface PrevSample {
  slot: string;
  fiveHour: number;
  polledAt: number;
}

/** Current sample time plus the prior reading, when one exists. */
export interface VelocityInput {
  polledAt: number;
  prev: PrevSample | null;
}

/** ", spent 0.31/40.00 GBP" — or "" when the poll did not carry the numbers. */
function spendSuffix(a: AccountUsage): string {
  const s = a.creditSpend;
  if (!s || s.used === null) return "";
  const limit = s.limit === null ? "" : `/${s.limit.toFixed(2)}`;
  return `, spent ${s.used.toFixed(2)}${limit}${s.currency ? ` ${s.currency}` : ""}`;
}

export type SwitchDecision =
  | { action: "none"; reason: string }
  | { action: "urgent" | "spread"; to: string; reason: string };

/**
 * How soon a slot trips, as the WORSE of its two windows.
 *
 * Scoring on one window hides the other: a slot quiet right now but nearly out
 * of week outranked a genuinely roomy one, which is how a switch INTO an
 * exhausted account happened on 2026-08-09. An unknown window counts as 0 —
 * `null` means the poll failed, and candidates with a failed 5h poll are
 * excluded upstream rather than guessed at here.
 */
export const worst = (a: AccountUsage): number => Math.max(a.fiveHour ?? 0, a.sevenDay ?? 0);

/**
 * Best slot to move to: lowest worst() within the lowest tier, excluding the
 * current one and anything whose 5h is unknown (an unpolled account only LOOKS
 * free).
 *
 * TIER dominates the sort, so free capacity always beats paid capacity however
 * roomy the paid account looks. Within a tier, the third key breaks an exact
 * tie AWAY from a credit account: two equally roomy destinations are not
 * equally safe, because work parked on the credit one starts billing the moment
 * its window closes — up to a poll interval before anything notices. It never
 * overrides worst(), so nothing is stranded to get it; the tie used to fall to
 * alphabetical order, which is not a reason.
 */
export function pickBest(
  accounts: AccountUsage[],
  exceptSlot: string,
  weeklyAt: number = WEEKLY_AT,
): AccountUsage | null {
  const billable = (a: AccountUsage) => (a.credits === "on" ? 1 : 0);
  const candidates = accounts
    .filter((a) => a.slot !== exceptSlot && candidateTier(a, weeklyAt) !== null)
    .sort(
      (a, b) =>
        candidateTier(a, weeklyAt)! - candidateTier(b, weeklyAt)! ||
        worst(a) - worst(b) ||
        billable(a) - billable(b) ||
        a.slot.localeCompare(b.slot),
    );
  return candidates[0] ?? null;
}

/**
 * Points per second the active slot's 5h window is burning, or null when that
 * cannot be known.
 *
 * `prev.slot` is load-bearing. A switch resets the series: two accounts'
 * readings are not one sequence, and subtracting across a switch invents a burn
 * rate out of unrelated numbers. Python guards this the same way, by only
 * carrying `_prev_five_hour` forward when the active slot is unchanged.
 *
 * A single reading has no rate. A falling rate is not a rate worth acting on —
 * only an upward burn can hit a wall.
 */
function burnRate(activeSlot: string, activeFive: number, v: VelocityInput | undefined): number | null {
  if (!v?.prev || v.prev.slot !== activeSlot) return null;
  const dt = v.polledAt - v.prev.polledAt;
  if (!(dt > 0)) return null;
  const rate = (activeFive - v.prev.fiveHour) / dt;
  return rate > 0 ? rate : null;
}

/**
 * Decide whether to switch, and why.
 *
 * `sinceLastSwitchSec` is Infinity when nothing has switched yet. The two
 * cooldowns are deliberately different: an URGENT move only waits out the short
 * one, because a stalled thread costs more than a churned Keychain, while a
 * SPREAD move waits out the long one, because it is an optimization and
 * optimizations must not thrash.
 *
 * Three things make a move URGENT, and each was bought with an outage:
 *  - BURST: 5h at or past switchAt.
 *  - WEEKLY: 7d at or past weeklyAt. 2026-07-31 — active sat at 7d 100% / 5h 13%
 *    with two idle slots, and a fresh-looking 5-hour window kept a dead account
 *    in place because only spread could move it.
 *  - VELOCITY: the burn rate says the NEXT sample lands past switchAt.
 *    2026-08-09 — read 90% and was walled before the next 180s poll. A static
 *    threshold assumes the next sample arrives in time; a fast fleet means it
 *    does not.
 */
export function decideSwitch(
  accounts: AccountUsage[],
  policy: SwitchPolicy,
  sinceLastSwitchSec: number,
  velocity?: VelocityInput,
): SwitchDecision {
  if (sinceLastSwitchSec < policy.cooldownSec) {
    return { action: "none", reason: `cooldown (${Math.round(sinceLastSwitchSec)}s < ${policy.cooldownSec}s)` };
  }
  const active = accounts.find((a) => a.active);
  if (!active) return { action: "none", reason: "no active account in the usage cache" };

  const weeklyAt = policy.weeklyAt ?? WEEKLY_AT;
  const horizon = policy.pollIntervalSec ?? POLL_INTERVAL_S;

  const best = pickBest(accounts, active.slot, weeklyAt);
  if (!best) return { action: "none", reason: "no eligible alternative slot" };

  const activeFive = active.fiveHour ?? 0;
  const activeSeven = active.sevenDay ?? 0;
  const rate = burnRate(active.slot, activeFive, velocity);
  const projected = rate === null ? null : activeFive + rate * horizon;

  let why: string | null = null;
  if (activeSeven >= weeklyAt) {
    why = `7d ${activeSeven}% >= ${weeklyAt}% (a week does not wait out)`;
  } else if (activeFive >= policy.switchAt) {
    why = `5h ${activeFive}% >= ${policy.switchAt}%`;
  } else if (projected !== null && projected >= policy.switchAt) {
    why = `velocity: 5h ${activeFive}% projected ~${projected.toFixed(0)}% >= ${policy.switchAt}% by next poll`;
  }

  // PAID CAPACITY IS THE LAST RESORT, AND ONLY ONCE THE ACTIVE SLOT IS SPENT
  // (MX-210). A tier-1 destination has Usage credits, i.e. capacity that costs
  // money. Moving onto it while the active slot still has free window strands a
  // use-it-or-lose-it 5-hour window AND starts spending — the worst of both. A
  // blind active slot counts as NOT spent: a failed poll must never be the
  // thing that authorises a bill.
  const bestIsPaid = candidateTier(best, weeklyAt) === 1;

  if (why !== null) {
    if (bestIsPaid) {
      const activeFree = hasFreeWindow(active, weeklyAt);
      if (activeFree !== false) {
        const held = activeFree ? "still has free window" : "cannot be read, so it is not known to be spent";
        return {
          action: "none",
          reason:
            `only paid capacity elsewhere (${best.slot} has usage credits); ` +
            `${active.slot} ${held} (5h ${active.fiveHour ?? "unknown"}%, 7d ${active.sevenDay ?? "unknown"}%)`,
        };
      }
      return {
        action: "urgent",
        to: best.slot,
        reason:
          `proactive: ${why} — NO free window anywhere, falling back to PAID capacity ` +
          `on ${best.slot} (usage credits${spendSuffix(best)})`,
      };
    }
    // Only move if the destination is actually better on its worst window —
    // otherwise this is a switch into the same wall, one slot over.
    if (worst(best) >= worst(active)) {
      return { action: "none", reason: `active at ${worst(active)}% but ${best.slot} is no better (${worst(best)}%)` };
    }
    return {
      action: "urgent",
      to: best.slot,
      reason: `proactive: ${why} (best alternative ${best.slot} at ${worst(best)}%)`,
    };
  }

  // SPREAD NEVER SPENDS MONEY. Spread is an optimization — it moves off a slot
  // that is merely worse, not walled — and an optimization is not a reason to
  // start billing. The urgent path above is the only one allowed onto credits.
  if (bestIsPaid) {
    return { action: "none", reason: `spread declined: ${best.slot} is paid capacity, and spread does not bill` };
  }

  if (!(policy.spreadMargin > 0)) return { action: "none", reason: "spread disabled" };
  const gap = worst(active) - worst(best);
  if (gap < policy.spreadMargin) {
    return { action: "none", reason: `gap ${gap} < margin ${policy.spreadMargin}` };
  }
  if (sinceLastSwitchSec < policy.spreadCooldownSec) {
    return {
      action: "none",
      reason: `spread cooldown (${Math.round(sinceLastSwitchSec)}s < ${policy.spreadCooldownSec}s)`,
    };
  }
  return {
    action: "spread",
    to: best.slot,
    reason: `spread: ${active.slot} at max(5h,7d)=${worst(active)}% vs ${best.slot} at ${worst(best)}% (gap ${gap} >= ${policy.spreadMargin})`,
  };
}

/**
 * Does this thread.failed error mean "this account is out of window", as
 * opposed to any of the thousand other ways a thread dies?
 *
 * This is the trigger for the entire reactive path, and it lived as an
 * un-exercised literal in server.ts until 2026-08-10, when Anthropic's wording
 * ("You've hit your session limit · resets 6pm") matched none of its branches
 * and six threads sat stopped while two accounts idled. The lesson is not "add
 * session" — it is that the vocabulary is the vendor's to change, so the match
 * has to be broad on the ways a limit can be phrased and narrow only on the
 * word `limit`/`quota`/`429` itself. False positives cost one wasted switch;
 * false negatives cost a night.
 */
export function isLimitError(error: string | null | undefined): boolean {
  if (!error) return false;
  return /rate.?limit|usage.?limit|session.?limit|weekly.?limit|429|subscription.*(limit|window)|out of.*(quota|usage)|hit your.*limit|reached your.*limit|limit.*resets/i
    .test(error);
}

/**
 * Everything the plugin knows about a thread.failed, from every source it has.
 *
 * `error` is bb's own field and is null on real limit failures — see
 * isLimitFailure. `rateLimitStatus` comes from the thread's own event stream:
 * the newest `provider/rateLimits/updated` bb recorded for it.
 *
 * It used to come from a follow-up `threads.rateLimitRecovery()` call, which
 * also carried bb's `reason` — its verdict on whether the failed request could
 * be replayed. bb 0.39.0 removed that method outright (get-bb/bb#1623), so
 * there is no `reason` any more and this interface no longer has one. Nothing
 * is lost in practice: of the 245 limit failures this plugin detected before
 * the removal, 245 were carried by `rate limits blocked` and none by `reason`
 * alone.
 */
export interface LimitFailureSignal {
  /** thread.failed's `error`. Null far more often than it looks. */
  error?: string | null;
  /** provider/rateLimits/updated -> data.rateLimits.status */
  rateLimitStatus?: string | null;
}

/**
 * Is this dead thread dead because the account ran out of window?
 *
 * isLimitError above is a good judge of a bad witness. On 2026-08-11 it was
 * proven that bb's thread.failed NEVER carries a rate-limit string: bb fills
 * that field from getLastThreadErrorMessage(), which reads only events of type
 * `system/error`, and provider limits are written as `provider/error`. The
 * event table that morning held 100 provider/error rows and 1 system/error
 * row. Consequence: the reactive path had never fired once in the plugin's
 * life, the stuck-thread store had never held a single record, and every
 * overnight rate limit was recovered by hand or not at all.
 *
 * So the trigger no longer depends on that field alone. The second signal is
 * `rateLimits.status === "blocked"` — bb saw the provider block this thread's
 * window — read from the newest `provider/rateLimits/updated` event on the
 * thread. That event lands right before the failure, which is why it is the
 * one that catches the real case: every one of the 245 failures this plugin
 * detected between 2026-08-09 and 2026-08-19 carried it.
 *
 * There used to be a third, `reason === "eligible"` from
 * `threads.rateLimitRecovery()`. bb 0.39.0 removed that call (get-bb/bb#1623)
 * and nothing outside bb's own provider-retry plugin can produce a `reason`
 * now. It never once fired on its own — all 245 detections above also had
 * `blocked` — so its loss costs no coverage. Deliberately NOT a signal, then
 * as now: any OTHER reason. Those describe why a resume was refused, not what
 * killed the thread, and treating them as limit evidence would track every
 * ENOENT on the machine.
 */
export function isLimitFailure(signal: LimitFailureSignal): boolean {
  if (isLimitError(signal.error)) return true;
  return signal.rateLimitStatus === "blocked";
}

/** One `provider/rateLimits/updated` row, structurally — lib.ts imports nothing. */
export interface RateLimitsEventRow {
  type: string;
  data: { rateLimits: { providerId: string; status: string } };
}

/**
 * Pick this provider's rate-limit status out of a newest-first page of
 * `provider/rateLimits/updated` events, or null if the page holds none.
 *
 * The page must be `order: "desc"`, because the FIRST match is the answer: a
 * thread's rate-limit state is whatever bb observed most recently, and an
 * older `blocked` under a newer `allowed` would resurrect a limit the account
 * has since climbed out of.
 *
 * The providerId filter is bb's own (provider-retry's
 * findLatestProviderRateLimitsEvent) and matters for the same reason: a thread
 * that has run on two providers interleaves their observations, so the newest
 * event of this type is not necessarily the one being asked about. No signal
 * is the safe answer — it means no adoption, not a wrong adoption.
 */
export function rateLimitStatusFrom(
  page: readonly RateLimitsEventRow[],
  providerId: string,
): string | null {
  for (const row of page) {
    if (row.type !== "provider/rateLimits/updated") continue;
    if (row.data.rateLimits.providerId !== providerId) continue;
    return row.data.rateLimits.status;
  }
  return null;
}

// ── Reconciliation — finding stuck threads the event stream never reported ──
//
// The store above is fed by onLimitFailure(), which is fed by thread.failed.
// On 2026-08-11 that single dependency was found to have been broken for the
// plugin's entire life by one upstream null, silently, with no alarm: see
// isLimitFailure. Fixing the trigger fixes today's cause. It does not stop the
// same SHAPE of failure — one quiet upstream change disabling recovery — from
// happening again.
//
// So the watch tick also looks for itself. Any errored thread the store does
// not know about is a candidate, confirmed by the same rate-limit inspection
// the trigger uses, so adoption can never be laxer than detection.

export interface ListedThread {
  id: string;
  status: string;
  updatedAt: number;
  archivedAt?: number | null;
  deletedAt?: number | null;
}

export interface AdoptionPlan {
  /** Thread ids to inspect and, if genuinely limit-failed, adopt. */
  inspect: string[];
  /** The inspection memory to persist: threadId -> the updatedAt just examined. */
  retain: Record<string, number>;
}

/**
 * Which listed threads are worth an inspection call this tick?
 *
 * The trap here is a loop, and it is not hypothetical: a thread that is adopted,
 * exhausts `maxAttempts` and gets dropped is still `error` and no longer
 * tracked — so a naive scan re-adopts it on the very next tick, forever, and
 * the attempts budget becomes decorative.
 *
 * The guard is `inspected`: the updatedAt of the last inspection per thread. A
 * genuinely dead thread's updatedAt never moves again, so it costs exactly one
 * inspection ever. A thread that really does change gets looked at again. That
 * also keeps a machine full of long-dead error threads from costing an
 * inspection each, every two minutes, all day.
 */
export function planAdoption(
  listed: ListedThread[],
  tracked: string[],
  inspected: Record<string, number>,
  now: number,
  giveUpAfterSec: number,
): AdoptionPlan {
  const trackedSet = new Set(tracked);
  const inspect: string[] = [];
  const retain: Record<string, number> = {};

  for (const t of listed) {
    if (t.status !== "error" || t.archivedAt || t.deletedAt) continue;
    // Carry the memory forward for every still-errored thread, so the map is
    // pruned to reality rather than growing with every thread that ever failed.
    const previous = inspected[t.id];
    retain[t.id] = t.updatedAt;
    if (trackedSet.has(t.id)) continue;
    if (previous === t.updatedAt) continue;
    // Already past the give-up clock: adopting it would spend an inspection
    // only to drop it on the same sweep.
    if (giveUpAfterSec > 0 && now - t.updatedAt > giveUpAfterSec * 1000) continue;
    inspect.push(t.id);
  }

  return { inspect, retain };
}

// ── Recovery sweep — resuming EVERY stuck thread when capacity returns ──────
//
// `bb.sdk.threads.list` has no status/providerId filter, so "which threads
// are stuck" cannot be queried from bb — it is tracked here as a small
// durable set, fed only by onLimitFailure(), which is only ever called after
// isLimitError() upstream. There is no second detector, and no code path
// here re-implements that judgement.

export interface StuckThreadRecord {
  threadId: string;
  providerId: string;
  /** First time this thread was ever seen limit-failed. Never overwritten. */
  firstFailedAt: number;
  /** Most recent limit-failure. Refreshed every time onLimitFailure fires again. */
  lastFailedAt: number;
  /** Most recent attemptContinue call, successful or not. Null = never attempted. */
  lastAttemptAt: number | null;
  /** Count of attemptContinue calls that came back not-eligible/error. */
  attempts: number;
  /**
   * Milliseconds this thread has spent stuck while the MACHINE had no capacity
   * — every account walled. Excluded from the give-up clock, because that clock
   * is meant to measure "this thread looks unrecoverable", and a dry spell says
   * nothing about the thread. Absent on records written before this existed.
   */
  stalledMs?: number;
}

export interface RecoveryPolicy {
  /** Min seconds between attemptContinue calls on the SAME thread. */
  attemptCooldownSec: number;
  /** Give up on a thread after this many failed attempts. 0 = unlimited. */
  maxAttempts: number;
  /** Give up on a thread this long after firstFailedAt, regardless of attempts. 0 = never. */
  giveUpAfterSec: number;
}

export interface SweepPlan {
  /** Oldest-stuck-first, deterministic tie-break by threadId. */
  attempt: StuckThreadRecord[];
  /** threadIds to stop tracking this tick (maxAttempts or giveUpAfterSec exceeded). */
  drop: string[];
  /** threadIds still tracked but skipped this tick (under attemptCooldownSec, or cornered). */
  waiting: string[];
  /** ms to add to every tracked record's stalledMs. Nonzero only while cornered. */
  stallCreditMs: number;
}

/** What the machine could serve right now, from the sweeper's point of view. */
export interface SweepCapacity {
  /** False when EVERY account is walled, so any attempt is doomed before it is made. */
  available: boolean;
  /** ms since the previous sweep — credited to stall time while unavailable. */
  sinceLastSweepMs: number;
}

const FULL_CAPACITY: SweepCapacity = { available: true, sinceLastSweepMs: 0 };

/**
 * Pure: no clock reads, no I/O. `now` and `candidates` are the entire input,
 * exactly like decideSwitch. Live thread status is deliberately NOT part of
 * this decision — that is a fact the impure sweep() re-checks per candidate
 * right before attempting, since it can change for reasons this module never
 * causes (provider-retry, a human, an earlier sweep).
 *
 * CAPACITY GATES EVERYTHING. When no account can serve a request, this returns
 * no attempts and — critically — no drops.
 *
 * Both give-up rules measure "this thread looks unrecoverable". Neither means
 * that while the whole machine is walled: an attempt that fails because every
 * account is spent says nothing about the thread. Spending the budget anyway is
 * how the 2026-08-10 shape ends badly — with the live defaults (5 attempts,
 * 120s apart) every stuck thread was dropped 10 minutes in, while the soonest
 * account reset was still 87 minutes away. The threads would have been given up
 * on long before the capacity they were waiting for arrived.
 */
export function planSweep(
  candidates: StuckThreadRecord[],
  now: number,
  policy: RecoveryPolicy,
  capacity: SweepCapacity = FULL_CAPACITY,
): SweepPlan {
  if (!capacity.available) {
    return {
      attempt: [],
      drop: [],
      waiting: candidates.map((c) => c.threadId),
      stallCreditMs: Math.max(0, capacity.sinceLastSweepMs),
    };
  }
  const drop: string[] = [];
  const waiting: string[] = [];
  const eligible: StuckThreadRecord[] = [];

  for (const c of candidates) {
    if (policy.maxAttempts > 0 && c.attempts >= policy.maxAttempts) {
      drop.push(c.threadId);
      continue;
    }
    // Stuck time only counts while the machine could actually have served it.
    if (policy.giveUpAfterSec > 0 && now - c.firstFailedAt - (c.stalledMs ?? 0) > policy.giveUpAfterSec * 1000) {
      drop.push(c.threadId);
      continue;
    }
    if (c.lastAttemptAt !== null && now - c.lastAttemptAt < policy.attemptCooldownSec * 1000) {
      waiting.push(c.threadId);
      continue;
    }
    eligible.push(c);
  }

  eligible.sort((a, b) => a.firstFailedAt - b.firstFailedAt || a.threadId.localeCompare(b.threadId));
  return { attempt: eligible, drop, waiting, stallCreditMs: 0 };
}

export type ThreadStatus = "error" | "active" | "starting" | "idle" | "stopping" | "not-found";

export interface StuckThreadStore {
  list(): Promise<StuckThreadRecord[]>;
  upsert(record: StuckThreadRecord): Promise<void>;
  remove(threadId: string): Promise<void>;
}

export interface ThreadStatusPort {
  getStatus(threadId: string): Promise<ThreadStatus>;
}

export type RecoveryAttemptResult =
  | { outcome: "continued" }
  | { outcome: "not-eligible"; reason: string }
  | { outcome: "error"; message: string };

export interface ThreadRecoveryPort {
  /**
   * Get this thread moving again now that an account has capacity. Hides the
   * settle delay and whatever mechanism bb currently offers for restarting a
   * stopped thread.
   */
  attemptContinue(threadId: string): Promise<RecoveryAttemptResult>;
}

/** Tag for logging/observability only — must never change planSweep's judgement. */
export type SweepTrigger = "reactive" | "proactive-switch" | "placement" | "periodic";

export interface SweepResult {
  trigger: SweepTrigger;
  attempted: string[];
  continued: string[];
  dropped: string[];
  waiting: number;
  /** True when the sweep held because no account had capacity. */
  stalled?: boolean;
}

export interface RecoverySweeper {
  /**
   * Call exactly once per thread.failed event AFTER isLimitError(error) is
   * true. Idempotent per threadId: repeat failures refresh lastFailedAt but
   * preserve firstFailedAt/attempts, so cooldown/give-up math isn't reset by
   * a thread that keeps failing.
   */
  onLimitFailure(threadId: string, providerId: string, now?: number): Promise<void>;
  /**
   * Call after ANY successful account switch, AND on every watch tick even
   * when nothing switched — an account can regain capacity on its own
   * (5h/7d window rolling forward) with no switch event to hang a sweep off
   * of. Never throws for expected failure modes; those are reflected in the
   * returned result. Not reentrant — a sweep already in flight makes a
   * concurrent call return a zero-progress result rather than double-attempt
   * a candidate.
   */
  sweep(trigger: SweepTrigger, now?: number): Promise<SweepResult>;
}

export interface RecoverySweeperDeps {
  store: StuckThreadStore;
  status: ThreadStatusPort;
  recovery: ThreadRecoveryPort;
  policy: RecoveryPolicy;
  /**
   * Can ANY account serve a request right now? When this says no, the sweep
   * holds instead of spending attempts on a doomed retry. Omitted = always
   * available, which is the pre-capacity behaviour.
   */
  hasCapacity?: () => Promise<boolean>;
  now?: () => number;
  log?: (msg: string) => void;
}

export function createRecoverySweeper(deps: RecoverySweeperDeps): RecoverySweeper {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  let sweeping = false;
  let lastSweepAt: number | null = null;

  async function onLimitFailure(threadId: string, providerId: string, at: number = now()): Promise<void> {
    const existing = (await deps.store.list()).find((r) => r.threadId === threadId);
    await deps.store.upsert({
      threadId,
      providerId,
      firstFailedAt: existing?.firstFailedAt ?? at,
      lastFailedAt: at,
      lastAttemptAt: existing?.lastAttemptAt ?? null,
      attempts: existing?.attempts ?? 0,
    });
  }

  async function sweep(trigger: SweepTrigger, at: number = now()): Promise<SweepResult> {
    const result: SweepResult = { trigger, attempted: [], continued: [], dropped: [], waiting: 0 };
    if (sweeping) return result;
    sweeping = true;
    try {
      const candidates = await deps.store.list();
      const available = deps.hasCapacity ? await deps.hasCapacity() : true;
      const sinceLastSweepMs = lastSweepAt === null ? 0 : at - lastSweepAt;
      lastSweepAt = at;

      const plan = planSweep(candidates, at, deps.policy, { available, sinceLastSweepMs });
      result.waiting = plan.waiting.length;
      result.stalled = !available;

      // Bank the dry time against every tracked thread so the give-up clock
      // does not run out during an outage the thread had no part in.
      if (plan.stallCreditMs > 0) {
        for (const c of candidates) {
          await deps.store.upsert({ ...c, stalledMs: (c.stalledMs ?? 0) + plan.stallCreditMs });
        }
        log(`sweep(${trigger}): no account has capacity — holding ${candidates.length} thread(s), no attempts spent`);
      }

      for (const threadId of plan.drop) {
        await deps.store.remove(threadId);
        result.dropped.push(threadId);
      }

      for (const candidate of plan.attempt) {
        try {
          const status = await deps.status.getStatus(candidate.threadId);
          if (status !== "error") {
            // Resolved elsewhere (provider-retry, a human, a prior sweep) —
            // not an attempt, not a drop, just quietly no longer tracked.
            await deps.store.remove(candidate.threadId);
            continue;
          }
          result.attempted.push(candidate.threadId);
          const outcome = await deps.recovery.attemptContinue(candidate.threadId);
          if (outcome.outcome === "continued") {
            await deps.store.remove(candidate.threadId);
            result.continued.push(candidate.threadId);
          } else {
            await deps.store.upsert({ ...candidate, lastAttemptAt: at, attempts: candidate.attempts + 1 });
          }
        } catch (e) {
          // One bad candidate must never abort the rest of the sweep.
          log(`sweep: ${candidate.threadId} failed: ${e instanceof Error ? e.message : e}`);
        }
      }
    } finally {
      sweeping = false;
    }
    return result;
  }

  return { onLimitFailure, sweep };
}
