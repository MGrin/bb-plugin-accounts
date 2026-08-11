// The switch decision, as a pure function.
//
// It used to live inside the 2-minute cron callback, tangled with kv reads and
// an execFile — which meant the one piece of logic that decides, unattended and
// all night, which Claude account your work bills to could not be exercised at
// all. Everything I/O-shaped stays in server.ts; everything judgement-shaped is
// here, where `node --test` can ask it awkward questions.

export interface AccountUsage {
  slot: string;
  active: boolean;
  /** Percent utilization of the rolling 5-hour window, null when unknown. */
  fiveHour: number | null;
  /** Percent utilization of the 7-day window, null when unknown. */
  sevenDay: number | null;
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
   * 7d % at which the active slot must be abandoned. Deliberately LOWER than
   * switchAt: a 5-hour window can be waited out, a weekly one resets on a
   * calendar date. Also caps which slots may be switched INTO.
   */
  weeklyAt?: number;
  /** Seconds ahead the burn rate is projected. Matches the poller's interval. */
  pollIntervalSec?: number;
}

const WEEKLY_AT = 95;
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
 * Best slot to move to: lowest worst(), excluding the current one, anything
 * whose 5h is unknown (an unpolled account only LOOKS free), and anything whose
 * week is spent (switching in trips again on the next poll).
 */
export function pickBest(
  accounts: AccountUsage[],
  exceptSlot: string,
  weeklyAt: number = WEEKLY_AT,
): AccountUsage | null {
  const candidates = accounts
    .filter((a) => a.slot !== exceptSlot && a.fiveHour !== null && (a.sevenDay ?? 0) < weeklyAt)
    .sort((a, b) => worst(a) - worst(b) || a.slot.localeCompare(b.slot));
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

  if (why !== null) {
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
 * isLimitFailure. The other two come from a follow-up
 * `threads.rateLimitRecovery()` call, which returns its `rateLimits` snapshot
 * on EVERY inspection, including the ones whose `reason` is a refusal.
 */
export interface LimitFailureSignal {
  /** thread.failed's `error`. Null far more often than it looks. */
  error?: string | null;
  /** ProviderRateLimitRecoveryStatus.rateLimits?.status */
  rateLimitStatus?: string | null;
  /** ProviderRateLimitRecoveryStatus.reason */
  recoveryReason?: string | null;
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
 * So the trigger no longer depends on that field alone. Two more signals,
 * both from bb's own recovery inspection, and either one is sufficient:
 *
 *  - `rateLimits.status === "blocked"` — bb saw the provider block this
 *    thread's window. This is the one that catches the real case, because the
 *    `provider/rateLimits/updated` event lands right before the failure.
 *  - `reason === "eligible"` — bb has a resume candidate ready, which it only
 *    ever builds for a terminal rate-limit error.
 *
 * Deliberately NOT a signal: any other `reason`. They describe why a resume is
 * refused, not what killed the thread, and treating them as limit evidence
 * would track every ENOENT on the machine.
 */
export function isLimitFailure(signal: LimitFailureSignal): boolean {
  if (isLimitError(signal.error)) return true;
  if (signal.rateLimitStatus === "blocked") return true;
  return signal.recoveryReason === "eligible";
}

/**
 * bb won't resume this thread by its own route — is a plain follow-up message
 * still worth sending?
 *
 * continueAfterRateLimit replays a specific failed request, and it needs a
 * stored candidate. thr_3waqz7vb9w had none: its limit arrived as an
 * agentMessage, so `bb thread retry` refused with "no-rate-limit-state" and
 * the thread sat dead for ten hours. What actually revived it was an ordinary
 * message (`bb thread tell --mode auto`) — the same thing a human does.
 *
 * The three reasons below all mean "bb has no candidate, and the thread really
 * is stopped in error". Every other reason is bb ruling on the thread in a way
 * a nudge would override: it is already retrying it, the thread is alive
 * again, the failed turn did work a nudge might duplicate, a human asked to
 * drive, or the environment is gone. Those get left alone.
 */
export function shouldNudgeAfterIneligible(reason: string): boolean {
  return reason === "no-rate-limit-state" ||
    reason === "no-terminal-rate-limit-error" ||
    reason === "input-not-accepted";
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
  /** Hides the rateLimitRecovery -> continueAfterRateLimit two-step and its settle delay. */
  attemptContinue(threadId: string): Promise<RecoveryAttemptResult>;
}

/** Tag for logging/observability only — must never change planSweep's judgement. */
export type SweepTrigger = "reactive" | "proactive-switch" | "periodic";

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
