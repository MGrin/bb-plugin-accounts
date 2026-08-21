// bb-plugin-accounts — Claude Max account switching inside bb.
//
// The standalone Python poller (claude.usage-poll LaunchAgent) keeps polling
// Anthropic's usage endpoint for every captured account and owns the Keychain
// swap (`claude-acct use <slot>`). This plugin is the brain and the surface on
// top of it:
//  - reads ~/.config/claude-usage/usage.json (the poller's cache)
//  - `bb accounts` CLI + homepage usage tiles
//  - schedule: proactive switch when the ACTIVE slot crosses switchAt (default
//    97) to the freshest lowest-usage slot. The 5-hour window is use-it-or-lose-it
//    and refills every 5 hours, so it is worth leaving a sliver of; the 7-day
//    window is not, so weeklyAt is the WALL (100) and every account is ridden to
//    it. See the weeklyAt doc in lib.ts.
//  - thread.failed: a provider rate-limit failure IS the trigger — switch
//    immediately and auto-continue the failed thread via the SDK's
//    rate-limit-recovery path. Utilization thresholds can lie; the 429 doesn't.
import { execFile, execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
// The judgement lives in lib.ts so `node --test` can exercise it without a
// Keychain, a poller or a clock. A second copy here is how the two drift.
import {
  type CapacityVerdict,
  capacityVerdict,
  createRecoverySweeper,
  type CreditSpend,
  type CreditState,
  decideSwitch,
  isLimitError,
  isLimitFailure,
  type LimitFailureSignal,
  type ListedThread,
  pickBest as pickBestOf,
  planAdoption,
  type PrevSample,
  rateLimitStatusFrom,
  type RecoveryAttemptResult,
  type StuckThreadRecord,
  type StuckThreadStore,
  type ThreadRecoveryPort,
  type ThreadStatus,
  type ThreadStatusPort,
  worst,
} from "./lib.ts";
import { buildObservations, fitModelWeights, SEED_PRIORS } from "./analytics/calibrate.ts";
import { type AlertMemory, EMPTY_MEMORY, planAlerts } from "./analytics/alerts.ts";
import { buildForecast, type Forecast } from "./analytics/forecast.ts";
import { ingestUsage } from "./analytics/ingest.ts";
import { buildProfile } from "./analytics/profile.ts";
import { scanTranscripts } from "./analytics/scan.ts";
import { agentShape, prettyProject } from "./analytics/transcripts.ts";
import {
  envIdFromPath,
  type KnownProject,
  normalizeRemote,
  resolveRepo,
  threadIdFromPath,
} from "./analytics/repos.ts";
import { MIGRATIONS } from "./analytics/schema.ts";
import {
  type PlacementPlan,
  planPlacement,
  weightForModel,
} from "./analytics/placement.ts";
import {
  advanceStreak,
  assessOutage,
  outageSignals,
  DEFAULT_CONFIRM_POLLS,
  earliestUsable,
  EMPTY_STREAK,
  isConfirmed,
  type OutageAccount,
  type OutageStreak,
} from "./analytics/outage.ts";
import { DEFAULT_POLICY, estimateSevenPerFive, type SimAccount } from "./analytics/simulate.ts";
import {
  burnBy,
  burnByHourOfWeek,
  countDistinctPolls,
  latestSampleAt,
  readCalibratableIntervals,
  readCursors,
  readDemandSamples,
  readMessages,
  readSamples,
  readWindowPairs,
  readModelWeights,
  transcriptCoverage,
  repoResolutionSources,
  unresolvedCwds,
  writeCursor,
  writeCwdRepo,
  writeModelWeights,
  writeTranscriptRows,
} from "./analytics/store.ts";

const run = promisify(execFile);

/**
 * Which commit is this PROCESS actually running? (MX-139)
 *
 * bb bundles a `path:` plugin FROM SOURCE at reload, so the revision read here — at module
 * load, which is that same moment — is by construction the code now executing. Nothing else
 * on the machine can answer this:
 *   - `bb plugin list` prints `running` and the source PATH, never a revision.
 *   - `bb plugin source` prints path/installed/history; for a path: source there is no
 *     revision to record.
 *   - dist/ is NOT the loaded artifact and its mtime LIES. Measured 2026-08-18:
 *     dist/server.js stamped 11:25:44Z against an 11:40:15Z reload, while the running
 *     process held a string that existed only in server.ts. Never reason from it.
 *
 * So a checkout can sit clean on main, every drift check green, while the process runs
 * something else entirely — the last hop, invisible until now. That gap is how shipped
 * code kept not running on this machine (four separate incidents on 2026-08-18).
 *
 * Read SYNCHRONOUSLY on purpose: the value must be fixed before anything can observe it,
 * and it costs one git call once per load. Failure is not fatal and never guesses — a
 * plugin installed from a tarball has no git dir, which is a legitimate `rev: null`, and
 * `null` must stay distinguishable from "matches" so a checker reports UNKNOWN, not OK.
 */
const BUILD_STAMP: {
  rev: string | null;
  dirty: boolean | null;
  sourceDir: string;
  loadedAt: string;
  why: string | null;
} = (() => {
  const sourceDir = import.meta.dirname;
  const loadedAt = new Date().toISOString();
  try {
    const git = (args: string[]): string =>
      execFileSync("git", ["-C", sourceDir, ...args], { encoding: "utf8", timeout: 5000 }).trim();
    return {
      rev: git(["rev-parse", "HEAD"]),
      // Dirty matters as much as the revision: an edited working tree means the loaded
      // bundle matches NO commit, so comparing revisions alone would report a false match.
      dirty: git(["status", "--porcelain"]).length > 0,
      sourceDir,
      loadedAt,
      why: null,
    };
  } catch (e) {
    return {
      rev: null,
      dirty: null,
      sourceDir,
      loadedAt,
      why: e instanceof Error ? e.message : String(e),
    };
  }
})();
const USAGE = `${os.homedir()}/.config/claude-usage/usage.json`;
const CLAUDE_ACCT = `${os.homedir()}/.local/bin/claude-acct`;

const creditSpendShape = z.object({
  used: z.number().nullable(),
  limit: z.number().nullable(),
  util: z.number().nullable(),
  currency: z.string().nullable(),
});

const accountShape = z.object({
  slot: z.string(),
  email: z.string(),
  active: z.boolean(),
  fiveHour: z.number().nullable(),
  sevenDay: z.number().nullable(),
  fiveHourResetsAt: z.string().nullable(),
  sevenDayResetsAt: z.string().nullable(),
  // MX-210. "unknown" is a real answer, not a missing one: a poll that failed
  // knows nothing about credits, and reading that as "off" is the silent
  // downgrade to "exhausted" this plugin exists to avoid.
  credits: z.enum(["on", "off", "unknown"]),
  creditSpend: creditSpendShape.nullable(),
});
type Account = z.infer<typeof accountShape>;

const burnSliceShape = z.object({ key: z.string(), messages: z.number(), weightedK: z.number() });

const forecastShape = z.object({
  confidence: z.enum(["provisional", "fitted", "stale"]),
  coverage: z.object({
    distinctPolls: z.number(),
    latestSampleAt: z.number().nullable(),
    staleAfterSec: z.number(),
    demandSamples: z.number().optional(),
    neededPolls: z.number(),
  }),
  generatedAt: z.number(),
  horizonSec: z.number(),
  blackout: z.object({
    earliest: z.number().nullable(),
    likely: z.number().nullable(),
    latest: z.number().nullable(),
    endsAt: z.number().nullable(),
    expectedSec: z.number(),
  }),
  weeklyExhaustedAt: z.record(z.string(), z.number().nullable()),
  timeline: z.array(z.object({ ts: z.number(), headroom: z.number(), blacked: z.boolean() })),
  slotCurve: z.array(z.object({ slots: z.number(), blackoutHoursPerWeek: z.number() })),
});

export const rpcContract = defineRpcContract({
  forecast: { input: z.null(), output: forecastShape.nullable() },
  analytics: {
    input: z.object({ days: z.number() }),
    output: z.object({
      days: z.number(),
      coverage: z.object({
        messages: z.number(),
        firstTs: z.number().nullable(),
        lastTs: z.number().nullable(),
      }),
      byModel: z.array(burnSliceShape),
      byAgent: z.array(burnSliceShape),
      byProject: z.array(burnSliceShape),
      byRepo: z.array(burnSliceShape),
      byHourOfWeek: z.array(z.object({ dayOfWeek: z.number(), hour: z.number(), weightedK: z.number() })),
    }),
  },
  status: {
    input: z.null(),
    output: z.object({
      polledAt: z.number().nullable(),
      stale: z.boolean(),
      accounts: z.array(accountShape),
      // What the machine can serve, for the app panel (MX-220). It is the
      // SAME value `bb accounts outage` and the Übersicht widget read, from
      // the same function — the panel must not re-derive it from `credits`
      // and the two windows, because three surfaces quietly disagreeing is
      // how a reader loses the ability to tell which one is stale.
      capacity: z.enum(["free", "paid-only", "none", "unknown"]),
      lastSwitch: z
        .object({ at: z.number(), from: z.string(), to: z.string(), reason: z.string() })
        .nullable(),
    }),
  },
});

interface RawUsage {
  polledAt?: number;
  active?: string;
  accounts?: {
    slot: string;
    email: string;
    active: boolean;
    fiveHour?: { util?: number | null; resetsAt?: string | null } | null;
    sevenDay?: { util?: number | null; resetsAt?: string | null } | null;
    /** The oauth usage endpoint's `extra_usage`. The poller has captured it
     *  since 2026-07-23 (claude_accounts.py:463) and nothing read it until
     *  MX-210 — the credit state was one line away from the decision that
     *  needed it the whole time. */
    extraUsage?: {
      is_enabled?: boolean | null;
      monthly_limit?: number | null;
      used_credits?: number | null;
      utilization?: number | null;
      currency?: string | null;
      decimal_places?: number | null;
      spend_limit_reached?: boolean | null;
    } | null;
    error?: string;
  }[];
}

type RawAccount = NonNullable<RawUsage["accounts"]>[number];

/** Mirrors claude_accounts.credit_state — two brains over one Keychain must not
 *  disagree about what "has credits" means. */
function creditStateOf(a: RawAccount): CreditState {
  if (a.error) return "unknown";
  const xu = a.extraUsage;
  if (!xu || xu.is_enabled === null || xu.is_enabled === undefined) return "unknown";
  if (!xu.is_enabled || xu.spend_limit_reached) return "off";
  return "on";
}

/**
 * Spend in MAJOR currency units, or null when credits are not on.
 *
 * The endpoint reports minor units with the scale in `decimal_places`: a live
 * read on 2026-08-20 gave used_credits 31.0 of monthly_limit 4000 at
 * decimal_places 2 and called it utilization 0.775 — GBP 0.31 of GBP 40.00.
 * Printing the raw 31 would read as GBP 31, wrong by 100x in the alarming
 * direction.
 */
function creditSpendOf(a: RawAccount): CreditSpend | null {
  if (creditStateOf(a) !== "on") return null;
  const xu = a.extraUsage!;
  const dp = xu.decimal_places;
  const scale = typeof dp === "number" && dp >= 0 ? 10 ** dp : 1;
  const major = (v: number | null | undefined) => (typeof v === "number" ? v / scale : null);
  return {
    used: major(xu.used_credits),
    limit: major(xu.monthly_limit),
    util: typeof xu.utilization === "number" ? xu.utilization : null,
    currency: xu.currency ?? null,
  };
}

async function readUsage(): Promise<{ polledAt: number | null; accounts: Account[] }> {
  try {
    const raw = JSON.parse(await readFile(USAGE, "utf8")) as RawUsage;
    return {
      polledAt: raw.polledAt ?? null,
      accounts: (raw.accounts ?? []).map((a) => ({
        slot: a.slot,
        email: a.email,
        active: a.active,
        fiveHour: a.fiveHour?.util ?? null,
        sevenDay: a.sevenDay?.util ?? null,
        fiveHourResetsAt: a.fiveHour?.resetsAt ?? null,
        sevenDayResetsAt: a.sevenDay?.resetsAt ?? null,
        credits: creditStateOf(a),
        creditSpend: creditSpendOf(a),
      })),
    };
  } catch {
    return { polledAt: null, accounts: [] };
  }
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    autoSwitch: { type: "boolean", label: "Auto-switch accounts", default: true },
    switchAt: { type: "string", label: "5h utilization % that triggers a proactive switch", default: "97" },
    // 100 = the wall, not a margin. At 95 an account was abandoned with 5% of its
    // week unspent AND was an illegal destination, so once every slot drifted past
    // 95 nothing could switch at all and threads waited on tokens that existed.
    // The 7-day window is the scarce resource; it gets spent to the last point.
    weeklyAt: { type: "string", label: "7d utilization % that triggers a switch (and caps destinations)", default: "100" },
    downgradeModel: { type: "string", label: "Model to continue Fable threads on when only Fable's own limit is hit", default: "claude-opus-5[1m]" },
    cooldownSec: { type: "string", label: "Minimum seconds between switches", default: "120" },
    spreadMargin: {
      type: "string",
      label: "Switch early when another slot is this many points roomier (0 = never)",
      default: "25",
    },
    spreadCooldownSec: { type: "string", label: "Minimum seconds between early (spread) switches", default: "1800" },
    staleAfterMin: { type: "string", label: "Treat usage data older than this (min) as stale", default: "15" },
    recoveryCooldownSec: { type: "string", label: "Minimum seconds between resume attempts on the SAME stuck thread", default: "120" },
    // Unlimited since 2026-08-13, when weeklyAt became the wall. Accounts are now
    // ridden to 100%, so a stuck thread can legitimately fail several times in a
    // row while it crosses slots with a sliver of week left — burning all 5
    // attempts in 10 minutes and getting dropped for good, with capacity still
    // arriving. recoveryGiveUpAfterHours plus the sweeper's stall credit (which
    // does not count time the machine was walled) is the honest backstop; an
    // attempt counter measures the machine's state, not the thread's health.
    recoveryMaxAttempts: { type: "string", label: "Give up resuming a thread after this many failed attempts (0 = unlimited)", default: "0" },
    recoveryGiveUpAfterHours: { type: "string", label: "Give up resuming a thread this long after it first got stuck (0 = never)", default: "6" },
    // Placement — see the thread.created handler for what this can and cannot do.
    placeOnSpawn: { type: "boolean", label: "Check the account has room for a new thread's model before it starts", default: true },
    placementMinUnits: { type: "string", label: "Thousand weighted tokens a new thread must fit before its account counts as usable", default: "20" },
    placementPinMin: { type: "string", label: "Minutes a manually chosen account is left alone by placement", default: "60" },
    // See analytics/outage.ts. 3 distinct polls at 180s each is ~6-9 minutes of
    // agreement before the machine is willing to call itself out — long enough
    // that a switch mid-tick or a single bad read cannot produce the claim, short
    // enough that whoever is waiting learns about it while it still matters.
    outageConfirmPolls: {
      type: "string",
      label: "Distinct polls that must all show every account exhausted before it counts as confirmed",
      default: String(DEFAULT_CONFIRM_POLLS),
    },
  });

  // Analytics storage. Opened once at load; the host tracks the handle and
  // closes it on dispose/reload. Migrations are append-only — see schema.ts.
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);

  const isStale = async (polledAt: number | null) => {
    const { staleAfterMin } = await settings.get();
    return polledAt === null || Date.now() / 1000 - polledAt > Number(staleAfterMin) * 60;
  };

  /** The poller's account shape, as the outage predicate wants it. */
  const toOutageAccounts = (accounts: Account[]): OutageAccount[] =>
    accounts.map((a) => ({
      slot: a.slot,
      fiveUtil: a.fiveHour,
      sevenUtil: a.sevenDay,
      active: a.active,
      fiveResetsAt: a.fiveHourResetsAt,
      sevenResetsAt: a.sevenDayResetsAt,
    }));

  /**
   * The whole away-message answer in one read: is every account out, when does
   * the first one come back, and how many distinct polls have agreed.
   *
   * READ-ONLY, deliberately. The streak is advanced by the `watch` tick and
   * nowhere else, because it must count SCHEDULED observations: if asking the
   * question also advanced it, calling this three times in a row would answer
   * it, and one read masquerading as three is exactly the conclusion the
   * consecutive-poll rule exists to prevent.
   */
  async function currentOutage(read?: { polledAt: number | null; accounts: Account[] }) {
    const { polledAt, accounts } = read ?? (await readUsage());
    const { weeklyAt, outageConfirmPolls } = await settings.get();
    const stale = await isStale(polledAt);
    // From THIS poll, never a second read. An outage verdict and a capacity
    // verdict taken from two different polls can disagree, and after MX-218 the
    // first is DERIVED from the second — so they have to be one observation.
    const capacity = await capacityOf(polledAt, accounts, Number(weeklyAt));
    const verdict = assessOutage(toOutageAccounts(accounts), { weeklyAt: Number(weeklyAt), stale, capacity });
    const streak = (await bb.storage.kv.get<OutageStreak>("outage-streak")) ?? EMPTY_STREAK;
    const requiredPolls = Number(outageConfirmPolls) || DEFAULT_CONFIRM_POLLS;
    return { polledAt, stale, verdict, streak, requiredPolls, confirmed: isConfirmed(verdict, streak, requiredPolls) };
  }

  async function pickBest(exceptSlot: string): Promise<Account | null> {
    const { polledAt, accounts } = await readUsage();
    if (await isStale(polledAt)) return null;
    return (pickBestOf(accounts, exceptSlot) as Account | null) ?? null;
  }

  // Two switchers share one Keychain: this plugin and the Python poller
  // (claude_accounts.decide_switch, its own COOLDOWN in state.json). They do not
  // share cooldown state, and usage.json only learns who is active on the next
  // 180s poll — so right after the poller switches, the cache's `active` flag is
  // a lie, and acting on it would switch a second time for nothing. `claude-acct
  // current` reads the truth from the Keychain; disagreement means the cache is
  // behind, so skip this tick rather than reason about a stale world.
  async function activeSlotIsTrustworthy(cacheActive: string): Promise<boolean> {
    try {
      const { stdout } = await run(CLAUDE_ACCT, ["current"], { timeout: 10_000 });
      const live = stdout.trim();
      if (live && live !== cacheActive) {
        bb.log.info(`skipping watch: live slot ${live} != cached active ${cacheActive} (usage cache is behind)`);
        return false;
      }
    } catch {
      return true; // claude-acct unavailable: fall back to the cache rather than freeze
    }
    return true;
  }

  async function underCooldown(overrideSec?: number): Promise<boolean> {
    const { cooldownSec } = await settings.get();
    const window = overrideSec ?? Number(cooldownSec);
    const last = await bb.storage.kv.get<{ at: number }>("last-switch");
    return !!last && Date.now() - last.at < window * 1000;
  }

  async function switchTo(to: Account, from: string, reason: string): Promise<boolean> {
    try {
      await run(CLAUDE_ACCT, ["use", to.slot], { timeout: 30_000 });
    } catch (e) {
      bb.log.error(`switch to ${to.slot} FAILED: ${e instanceof Error ? e.message : e}`);
      return false;
    }
    await bb.storage.kv.set("last-switch", { at: Date.now(), from, to: to.slot, reason });
    bb.log.info(`switched ${from} -> ${to.slot} (${reason})`);
    bb.realtime.publish("accounts.switched", { from, to: to.slot, reason });
    return true;
  }

  // Recovery sweep — resumes EVERY currently-stuck limit-failed thread, not
  // just the one attached to whichever event fired. `bb.sdk.threads.list` has
  // no status/providerId filter, so "which threads are stuck" is tracked here
  // rather than queried from bb. Pure judgement (planSweep) and the port
  // shapes below live in lib.ts, under the same `node --test` coverage as
  // decideSwitch/isLimitError.
  const stuckThreadsStore: StuckThreadStore = {
    async list() {
      return (await bb.storage.kv.get<StuckThreadRecord[]>("stuck-threads")) ?? [];
    },
    async upsert(record) {
      const all = await stuckThreadsStore.list();
      await bb.storage.kv.set("stuck-threads", [...all.filter((r) => r.threadId !== record.threadId), record]);
    },
    async remove(threadId) {
      const all = await stuckThreadsStore.list();
      await bb.storage.kv.set("stuck-threads", all.filter((r) => r.threadId !== threadId));
    },
  };

  const threadStatus: ThreadStatusPort = {
    async getStatus(threadId): Promise<ThreadStatus> {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        return thread.status;
      } catch {
        return "not-found";
      }
    },
  };

  const threadRecovery: ThreadRecoveryPort = {
    /**
     * Restart a thread a rate limit stopped, now that some account can serve it.
     *
     * This was a two-step until 2026-08-21: ask `threads.rateLimitRecovery()`
     * for a replayable candidate, and `threads.continueAfterRateLimit()` it if
     * bb had one, falling back to a plain message when it did not. bb 0.39.0
     * removed BOTH methods, their HTTP routes and `bb thread retry` outright
     * (get-bb/bb#1623, "Move provider retry policy into the provider-retry
     * plugin") — the server keeps no rate-limit recovery policy at all now.
     *
     * The replay did not move somewhere this plugin can call. It moved into
     * bb's builtin provider-retry plugin, which schedules it for the moment
     * the window that blocked it rolls over (`resetsAtMs` + 15s, capped at
     * six hours). That wait is precisely what this sweep exists to skip: by
     * the time it runs, accounts has already moved the machine onto an account
     * with capacity, so the thread can go NOW rather than in five hours.
     *
     * So what is left is the fallback, and it was always the half that
     * actually worked. thr_3waqz7vb9w sat dead for ten hours on 2026-08-11
     * because its limit arrived as an agentMessage and bb had no replayable
     * request to offer; an ordinary follow-up message started it again
     * immediately.
     *
     * The eligibility reasons that used to gate this nudge are gone with the
     * call that produced them. Three gates still stand, all in the sweeper:
     * it only attempts a thread still sitting in `error` (a thread
     * provider-retry, a human or an earlier sweep already revived is dropped
     * untouched), only while some account has capacity, and only once per
     * recoveryCooldownSec.
     */
    async attemptContinue(threadId): Promise<RecoveryAttemptResult> {
      try {
        await new Promise((r) => setTimeout(r, 3000));
        // mode "auto", not the default "steer": bb rejects a steer into a thread
        // that is not active with HTTP 409 "Thread is not active", which is
        // exactly the state every stuck thread is in.
        await bb.sdk.threads.send({
          threadId,
          mode: "auto",
          input: [{
            type: "text",
            mentions: [],
            text:
              "[accounts] Provider capacity is back and this thread was stopped by a rate limit. " +
              "This is a plain restart rather than a retry of the failed call, so the request that hit the limit was never served. " +
              "Continue from where you left off — re-check anything whose result you never saw before acting on it.",
          }],
        });
        bb.log.info(`recovery: nudged ${threadId} back to life`);
        return { outcome: "continued" };
      } catch (e) {
        return { outcome: "error", message: e instanceof Error ? e.message : String(e) };
      }
    },
  };

  // Snapshotted at load, like the rest of this plugin's config surface
  // requires `bb plugin reload accounts` to pick up a settings change.
  const recoverySettings = await settings.get();

  /**
   * Could ANY account serve a request right now?
   *
   * A stale cache answers YES. A broken poller must not be able to freeze
   * recovery — an attempt that turns out to be doomed only costs one retry,
   * while refusing to attempt for hours costs the whole night.
   */
  /**
   * free / paid-only / none / unknown — see capacityVerdict.
   *
   * A stale cache is UNKNOWN for the same reason a failed poll is: the
   * instrument cannot see, so it asserts nothing. That was already this
   * function's behaviour (it returned "available" when stale); MX-210 only gave
   * the state a name so the two blind cases and the two sighted ones stop
   * sharing one boolean.
   */
  async function capacityOf(
    polledAt: number | null,
    accounts: Account[],
    weeklyAt: number,
  ): Promise<CapacityVerdict> {
    if (accounts.length === 0 || (await isStale(polledAt))) return "unknown";
    return capacityVerdict(accounts, weeklyAt);
  }

  async function machineCapacity(): Promise<CapacityVerdict> {
    const { polledAt, accounts } = await readUsage();
    return capacityOf(polledAt, accounts, Number(recoverySettings.weeklyAt));
  }

  /**
   * Can the sweeper get a thread served AT ALL right now?
   *
   * "only paid capacity left" is not an outage and must not hold the sweep —
   * that verdict is exactly what MX-210 was filed for: a machine reporting
   * itself walled while a paid path was open stalls work for no reason. It is
   * still not a licence to PREFER credits; the destination order in pickBest is
   * what keeps them last, and this answers a different question.
   */
  async function anyAccountHasCapacity(): Promise<boolean> {
    return (await machineCapacity()) !== "none";
  }

  const sweeper = createRecoverySweeper({
    store: stuckThreadsStore,
    status: threadStatus,
    recovery: threadRecovery,
    hasCapacity: anyAccountHasCapacity,
    policy: {
      attemptCooldownSec: Number(recoverySettings.recoveryCooldownSec),
      maxAttempts: Number(recoverySettings.recoveryMaxAttempts),
      giveUpAfterSec: Number(recoverySettings.recoveryGiveUpAfterHours) * 3600,
    },
    log: (m) => bb.log.info(m),
  });

  // Proactive path, every 2 minutes. Two triggers, because two different kinds
  // of capacity get stranded:
  //
  //  1. URGENT — the active slot's 5h window is nearly gone (>= switchAt). Move
  //     before the 429 so nothing stalls.
  //
  //  2. SPREAD — the active slot is merely WORSE than an idle one by a wide
  //     margin. Waiting for switchAt strands capacity at both ends: observed
  //     2026-08-09, the active account sat at 7d 82% (weekly window nearly gone,
  //     two days from reset) while two accounts sat at 7d 15% with their 5h
  //     windows about to refill — unused. The 5h window is use-it-or-lose-it per
  //     account and refills every 5 hours; the 7-day window is the scarce one.
  //     So burning the weekly of the account with the LEAST weekly headroom,
  //     while a roomy account idles, wastes both. Switching early spreads the
  //     load and keeps a fresh 5h window in reserve for when everything is hot.
  //
  //     Guarded hard, because churn costs a Keychain swap under running threads:
  //     it fires only on a wide margin (default 25 points of max(5h,7d)) and no
  //     more often than spreadCooldownSec (default 30 min).
  // The alarm that was missing on 2026-08-10.
  //
  // For hours the Python switcher logged "no candidate with headroom" every 180s
  // and told nobody, while six threads sat stopped. Every account was spent, so
  // no decision could have helped — the gap was not judgement, it was that
  // wanting to move and being unable to is INFORMATION and it went only to a log
  // file nobody reads at 07:00.
  //
  // Fire only when the active slot is actually over a trip line AND there is
  // nowhere to go. An ordinary quiet "none" means nothing is wrong. Rate-limited
  // to once per episode: a spent fleet would otherwise alarm every two minutes
  // all night, which trains you to ignore it.
  const CORNERED_RE = /no eligible alternative slot|is no better/;
  /**
   * When every account is walled, the only useful thing left to say is WHEN
   * that stops being true. Soonest 5h reset across all slots, since that is the
   * window that actually frees up on a human timescale.
   */
  /**
   * When the first walled account comes back.
   *
   * This used to be the minimum of every future 5-HOUR reset, which answers a
   * different question and answers it wrongly whenever an account is walled on
   * its week: a slot at 5h 100% / 7d 100% whose 5-hour window rolls over in 20
   * minutes is NOT back in 20 minutes, and "Next capacity ~10:19Z" in a
   * notification is exactly the confidently-wrong ETA this plugin now has a
   * rule against. The binding window decides, and a missing reset is UNKNOWN
   * rather than skipped — see analytics/outage.ts.
   */
  function nextCapacityAt(accounts: Account[], weeklyAt: number): Date | null {
    const { at } = earliestUsable(toOutageAccounts(accounts), weeklyAt);
    return at ? new Date(at) : null;
  }

  async function alarmIfCornered(
    reason: string,
    active: Account,
    accounts: Account[],
    switchAt: number,
    weeklyAt: number,
  ) {
    const tripping = (active.fiveHour ?? 0) >= switchAt || (active.sevenDay ?? 0) >= weeklyAt;
    if (!tripping || !CORNERED_RE.test(reason)) {
      await bb.storage.kv.delete("cornered-since");
      return;
    }
    if (await bb.storage.kv.get<number>("cornered-since")) return; // already alarmed this episode
    await bb.storage.kv.set("cornered-since", Date.now());
    const next = nextCapacityAt(accounts, weeklyAt);
    const stuck = (await stuckThreadsStore.list()).length;
    // A reset already in the past means the poller is behind, not that capacity
    // is negative minutes away. Say nothing rather than print "-3 min".
    const eta =
      next && next.getTime() > Date.now()
        ? ` Next capacity ~${next.toISOString().slice(11, 16)}Z (${Math.round((next.getTime() - Date.now()) / 60000)} min).`
        : "";
    const held = stuck ? ` ${stuck} thread(s) held for resume.` : "";
    const msg = `${active.slot} is at 5h ${active.fiveHour ?? "?"}% / 7d ${active.sevenDay ?? "?"}% and no account has headroom.${eta}${held}`;
    bb.log.warn(`cornered: ${msg} (${reason})`);
    try {
      await run("osascript", [
        "-e",
        `display notification ${JSON.stringify(msg)} with title ${JSON.stringify("Claude: out of accounts")}`,
      ], { timeout: 5_000 });
    } catch { /* a missing notifier must not break the watch */ }
  }

  /** The same osascript path alarmIfCornered uses — one notifier, one look. */
  async function notify(title: string, message: string): Promise<void> {
    try {
      await run("osascript", [
        "-e",
        `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
      ], { timeout: 5_000 });
    } catch { /* a missing notifier must not break the watch */ }
  }

  /**
   * Forecast-driven alerts. See analytics/alerts.ts for why these two exist and
   * why they are not the thing the standing "never raise usage limits"
   * instruction bans: they are about aggregate capacity, never one account, and
   * never attached to a running task.
   */
  async function evaluateAlerts(): Promise<void> {
    const forecast = await currentForecast();
    if (!forecast) return;
    const memory = (await bb.storage.kv.get<AlertMemory>("alert-memory")) ?? EMPTY_MEMORY;
    const plan = planAlerts(forecast, memory, Math.floor(Date.now() / 1000));
    if (plan.memory !== memory) await bb.storage.kv.set("alert-memory", plan.memory);
    for (const alert of plan.fire) {
      bb.log.warn(`alert(${alert.kind}): ${alert.message}`);
      await notify(alert.title, alert.message);
    }
  }

  bb.background.schedule("watch", "*/2 * * * *", async () => {
    const { autoSwitch, switchAt, weeklyAt, spreadMargin, cooldownSec, spreadCooldownSec, outageConfirmPolls } =
      await settings.get();
    const { polledAt, accounts } = await readUsage();

    // RECORDING COMES FIRST, AND IS UNCONDITIONAL.
    //
    // Not gated on autoSwitch: a machine with auto-switch off still burns
    // quota, and the history is the entire point. Not gated on staleness
    // either — a stale poll is still a fact about what the poller last saw,
    // and INSERT OR IGNORE makes re-reading the same polledAt free.
    //
    // Its own try/catch, deliberately. Everything below this line is the path
    // that keeps rate-limited threads alive; an analytics bug must never be
    // able to take that down with it.
    try {
      const { inserted, intervals } = ingestUsage(db, polledAt, accounts);
      if (inserted) bb.log.debug(`analytics: poll ${polledAt} recorded (${inserted} rows, ${intervals} intervals)`);
      await evaluateAlerts();
    } catch (e) {
      bb.log.warn(`analytics ingest failed: ${e instanceof Error ? e.message : e}`);
    }

    // OUTAGE TRACKING — unconditional and fenced, for the same two reasons.
    //
    // This tick IS the scheduled component the away message depends on: when
    // every account is out, the thing that would announce the outage is the
    // thing that cannot run, so the fact has to be established by something
    // already running and left somewhere cheap to read (`bb accounts outage`).
    //
    // Not gated on autoSwitch — a machine with switching off still goes dark.
    // Not gated on staleness either: assessOutage is HANDED the stale flag so
    // it can refuse, which is different from not asking, and skipping the tick
    // would freeze a streak in place instead of breaking it.
    try {
      const verdict = assessOutage(toOutageAccounts(accounts), {
        weeklyAt: Number(weeklyAt),
        stale: await isStale(polledAt),
        capacity: await capacityOf(polledAt, accounts, Number(weeklyAt)),
      });
      const before = (await bb.storage.kv.get<OutageStreak>("outage-streak")) ?? EMPTY_STREAK;
      const streak = advanceStreak(before, verdict, polledAt);
      // Re-reading the same poll is the common case (watch every 120s, poller
      // every 180s) and must not cost a write.
      if (streak.consecutive !== before.consecutive || streak.lastPolledAt !== before.lastPolledAt) {
        await bb.storage.kv.set("outage-streak", streak);
      }
      const required = Number(outageConfirmPolls) || DEFAULT_CONFIRM_POLLS;
      if (isConfirmed(verdict, streak, required) && !isConfirmed(verdict, before, required)) {
        bb.log.warn(`outage confirmed after ${streak.consecutive} polls: ${verdict.reason}`);
      }
    } catch (e) {
      bb.log.warn(`outage tracking failed: ${e instanceof Error ? e.message : e}`);
    }

    if (!autoSwitch) return;
    // Before anything that can return early: a stale poller or an untrustworthy
    // active slot must not also stop us NOTICING what is stuck.
    await reconcile(Number(recoverySettings.recoveryGiveUpAfterHours) * 3600);
    if (await isStale(polledAt)) return;
    const active = accounts.find((a) => a.active);
    if (!active) return;
    if (!(await activeSlotIsTrustworthy(active.slot))) return;

    // The velocity trip needs two samples of the SAME slot, so carry the last
    // reading across ticks. decideSwitch stays pure; the state lives here.
    const prev = await bb.storage.kv.get<PrevSample>("prev-sample");
    if (polledAt !== null && active.fiveHour !== null) {
      await bb.storage.kv.set("prev-sample", { slot: active.slot, fiveHour: active.fiveHour, polledAt });
    }

    const last = await bb.storage.kv.get<{ at: number }>("last-switch");
    const sinceSec = last ? (Date.now() - last.at) / 1000 : Number.POSITIVE_INFINITY;
    const decision = decideSwitch(
      accounts,
      {
        switchAt: Number(switchAt),
        weeklyAt: Number(weeklyAt),
        spreadMargin: Number(spreadMargin),
        cooldownSec: Number(cooldownSec),
        spreadCooldownSec: Number(spreadCooldownSec),
      },
      sinceSec,
      polledAt === null ? undefined : { polledAt, prev: prev ?? null },
    );
    if (decision.action === "none") {
      await alarmIfCornered(decision.reason, active, accounts, Number(switchAt), Number(weeklyAt));
      // No switch happened, but an account can regain capacity on its own
      // (5h/7d window rolling forward) with nothing to hang a sweep off of —
      // so sweep every watch tick regardless, not only right after a switch.
      const swept = await sweeper.sweep("periodic");
      if (swept.continued.length) bb.log.info(`periodic sweep on ${active.slot} resumed: ${swept.continued.join(", ")}`);
      return;
    }
    const target = accounts.find((a) => a.slot === decision.to);
    if (!target) return;
    await bb.storage.kv.delete("cornered-since");
    const switched = await switchTo(target, active.slot, decision.reason);
    if (switched) {
      const swept = await sweeper.sweep("proactive-switch");
      if (swept.continued.length) bb.log.info(`proactive switch to ${target.slot} resumed: ${swept.continued.join(", ")}`);
    }
  });

  // Transcript indexing — the retroactive half of the history.
  //
  // Deliberately its own schedule rather than a step in the watch tick: the
  // first run walks ~550MB of ~2650 files, and nothing that slow belongs
  // anywhere near the path that decides whether to switch accounts. After the
  // backfill each run reads kilobytes, because a file whose (size, mtime) match
  // its stored cursor is never opened at all.
  // ── cwd -> GitHub repo ───────────────────────────────────────────────────
  //
  // "Which repo did that go to" cannot be answered from the transcript alone:
  // it records a working directory, and 65 of this machine's 145 directories
  // no longer exist because bb worktrees are disposable. bb's own project
  // records survive that, so they are asked first; git is the most
  // authoritative source but the least available. resolveRepo owns the order
  // and is tested; this function only fetches what it needs.

  /** bb projects that actually map to a GitHub repo, keyed by project id. */
  async function knownProjects(): Promise<{ list: KnownProject[]; byId: Map<string, string> }> {
    const list: KnownProject[] = [];
    const byId = new Map<string, string>();
    try {
      const res = (await bb.sdk.projects.list()) as unknown;
      const rows = (Array.isArray(res) ? res : ((res as { projects?: unknown[] })?.projects ?? [])) as Array<{
        id?: string;
        name?: string;
        gitRemoteUrl?: string | null;
        sources?: Array<{ path?: string | null }>;
      }>;
      for (const row of rows) {
        // No remote means no repo — bb's personal project is the case that
        // matters, and labelling its 22% of burn with a repo name would be
        // inventing one.
        const name = normalizeRemote(row.gitRemoteUrl) ?? null;
        if (!name) continue;
        const paths = (row.sources ?? []).map((src) => src?.path).filter((p): p is string => !!p);
        list.push({ name, paths });
        if (row.id) byId.set(row.id, name);
      }
    } catch (e) {
      bb.log.warn(`project list failed, repo attribution will fall back to git: ${e instanceof Error ? e.message : e}`);
    }
    return { list, byId };
  }

  async function projectForPath(cwd: string, byId: Map<string, string>): Promise<string | null> {
    const envId = envIdFromPath(cwd);
    if (envId) {
      try {
        const env = (await bb.sdk.environments.get({ environmentId: envId })) as { projectId?: string };
        return env?.projectId ? (byId.get(env.projectId) ?? null) : null;
      } catch {
        return null; // a retired environment is expected, not exceptional
      }
    }
    const threadId = threadIdFromPath(cwd);
    if (threadId) {
      try {
        const thread = (await bb.sdk.threads.get({ threadId })) as { projectId?: string };
        return thread?.projectId ? (byId.get(thread.projectId) ?? null) : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  async function gitRemoteFor(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await run("git", ["-C", cwd, "config", "--get", "remote.origin.url"], { timeout: 5_000 });
      return stdout.trim() || null;
    } catch {
      return null; // directory gone, or not a repo
    }
  }

  /** Resolve every directory that has no cached answer. Cheap after the first pass. */
  async function resolveRepos(): Promise<number> {
    const pending = unresolvedCwds(db);
    if (pending.length === 0) return 0;
    const { list, byId } = await knownProjects();
    const now = Math.floor(Date.now() / 1000);
    for (const cwd of pending) {
      const environmentProject = await projectForPath(cwd, byId);
      // Only pay for a git call when the cheaper, durable layers came up empty.
      const needsGit = !environmentProject;
      const gitRemote = needsGit ? await gitRemoteFor(cwd) : null;
      const { repo, source } = resolveRepo(cwd, { projects: list, environmentProject, gitRemote });
      writeCwdRepo(db, cwd, repo, source, now);
    }
    return pending.length;
  }

  const TRANSCRIPT_ROOT = `${os.homedir()}/.claude/projects`;
  let indexing = false;

  /** Returns a one-line summary, or null when a run was already in flight. */
  async function indexTranscripts(): Promise<string | null> {
    // The backfill can outlast the interval. Overlapping runs would fight over
    // the same cursors and re-read the same bytes, so a run in flight simply
    // wins and the caller gets nothing rather than a duplicate pass.
    if (indexing) return null;
    indexing = true;
    const startedAt = Date.now();
    try {
      const cursors = readCursors(db);
      let written = 0;
      const result = await scanTranscripts(TRANSCRIPT_ROOT, cursors, (rows, filePath, cursor) => {
        // Rows BEFORE the cursor, always. A crash between the two re-reads a
        // batch, which the (session_id, message_id) key makes free; the other
        // order would advance past messages that were never stored.
        written += writeTranscriptRows(db, rows);
        writeCursor(db, filePath, cursor);
      });
      const resolved = await resolveRepos();
      const cov = transcriptCoverage(db);
      return (
        `indexed ${written} new message(s) from ${result.filesRead}/${result.filesSeen} transcript(s) ` +
        `in ${Math.round((Date.now() - startedAt) / 1000)}s — ${cov.messages} total` +
        (resolved ? `, resolved ${resolved} new working director${resolved === 1 ? "y" : "ies"} to repos` : "")
      );
    } finally {
      indexing = false;
    }
  }

  bb.background.schedule("index-transcripts", "*/15 * * * *", async () => {
    try {
      const summary = await indexTranscripts();
      if (summary && !summary.startsWith("indexed 0 ")) bb.log.info(`analytics: ${summary}`);
    } catch (e) {
      bb.log.warn(`transcript indexing failed: ${e instanceof Error ? e.message : e}`);
    }
  });

  // ── Forecasting ──────────────────────────────────────────────────────────

  /** How much demand history to feed the profile. */
  const PROFILE_LOOKBACK_SEC = 42 * 86400;
  /** Longest interval still trustworthy for calibration — beyond this a poll gap muddles attribution. */
  const CALIBRATION_MAX_INTERVAL_SEC = 600;

  /**
   * Live account state as the simulator wants it.
   *
   * A null resetsAt means the window has never been touched, so the safest
   * reading is a full window starting now — assuming it resets imminently
   * would forecast capacity that does not exist.
   */
  function toSimAccounts(accounts: Account[], now: number): SimAccount[] {
    const parse = (iso: string | null, fallbackSec: number): number => {
      const t = iso ? Date.parse(iso) : Number.NaN;
      return Number.isFinite(t) ? Math.floor(t / 1000) : now + fallbackSec;
    };
    return accounts.map((a) => ({
      slot: a.slot,
      fiveUtil: a.fiveHour ?? 0,
      fiveResetsAt: parse(a.fiveHourResetsAt, DEFAULT_POLICY.fiveWindowSec),
      sevenUtil: a.sevenDay ?? 0,
      sevenResetsAt: parse(a.sevenDayResetsAt, DEFAULT_POLICY.sevenWindowSec),
    }));
  }

  const readSamplesFor = (slot: string, sinceEpochSec: number) => readSamples(db, slot, sinceEpochSec);

  /**
   * Re-aggregate after relabelling. Grouping happens in SQL on the raw column,
   * and two different cwds legitimately share a label — a repo and a worktree
   * inside it both read as the same project — so without this the same name
   * appears twice with its burn split across the rows.
   */
  const mergeByKey = (slices: { key: string; messages: number; weightedK: number }[]) => {
    const merged = new Map<string, { key: string; messages: number; weightedK: number }>();
    for (const s of slices) {
      const prev = merged.get(s.key);
      if (prev) {
        prev.messages += s.messages;
        prev.weightedK += s.weightedK;
      } else {
        merged.set(s.key, { ...s });
      }
    }
    return [...merged.values()].sort((a, b) => b.weightedK - a.weightedK);
  };

  async function currentForecast(): Promise<Forecast | null> {
    const { switchAt, weeklyAt, staleAfterMin } = await settings.get();
    const { accounts } = await readUsage();
    if (accounts.length === 0) return null;
    const now = Math.floor(Date.now() / 1000);
    const demandSamples = readDemandSamples(db, now - PROFILE_LOOKBACK_SEC);
    const profile = buildProfile(demandSamples, now);
    // How much weekly window one 5h-window point costs, measured rather than
    // assumed. Assuming 1:1 predicted 324h of blackout in a 336h horizon.
    const sevenPerFive = estimateSevenPerFive(readWindowPairs(db, now - PROFILE_LOOKBACK_SEC));
    return buildForecast({
      accounts: toSimAccounts(accounts, now),
      profile,
      policy: { switchAt: Number(switchAt), weeklyAt: Number(weeklyAt), ...DEFAULT_POLICY, sevenPerFive },
      now,
      coverage: {
        distinctPolls: countDistinctPolls(db),
        latestSampleAt: latestSampleAt(db),
        staleAfterSec: Number(staleAfterMin) * 60,
        demandSamples: demandSamples.length,
      },
    });
  }

  // Nightly refit of the tokens -> utilization weights. Off-hours because it
  // reads the whole overlap period, and daily because the thing it is learning
  // (relative model cost) moves on the timescale of Anthropic shipping models,
  // not of anything that happens during a day.
  bb.background.schedule("calibrate", "17 4 * * *", async () => {
    try {
      const now = Math.floor(Date.now() / 1000);
      const since = now - PROFILE_LOOKBACK_SEC;
      const intervals = readCalibratableIntervals(db, since, CALIBRATION_MAX_INTERVAL_SEC);
      if (intervals.length === 0) {
        bb.log.info("calibrate: no usable overlap yet — keeping seeded weights");
        return;
      }
      const from = Math.min(...intervals.map((i) => i.t0));
      const to = Math.max(...intervals.map((i) => i.t1));
      const fit = fitModelWeights(buildObservations(intervals, readMessages(db, from, to)), SEED_PRIORS);
      writeModelWeights(db, fit, now);
      bb.log.info(
        `calibrate: fitted ${Object.keys(fit.weights).length} families over ${fit.sampleCount} intervals ` +
          `(residual ${fit.residual.toFixed(3)})`,
      );
    } catch (e) {
      bb.log.warn(`calibration failed: ${e instanceof Error ? e.message : e}`);
    }
  });

  /**
   * The newest provider rate-limit state bb recorded on this thread, or null.
   *
   * `provider/rateLimits/updated` carries the same `rateLimits` object the
   * removed `threads.rateLimitRecovery()` used to return, and reading it back
   * off the event stream is what bb's own provider-retry plugin does now
   * (plugins/provider-retry/src/recovery.ts, findLatestProviderRateLimitsEvent).
   *
   * One page, not bb's paging loop: it pages because a thread may interleave
   * providers and the newest event of this type need not be the one it wants.
   * Measured on this machine 2026-08-21 — all 8160 of these events are
   * `claude-code` and no thread has ever carried two providers — and this
   * plugin only ever asks about Claude. So a provider mismatch inside the
   * newest page means "no signal", which is the safe direction: no signal is
   * no adoption.
   */
  const RATE_LIMIT_PAGE = 100;
  async function latestRateLimitStatus(threadId: string, providerId: string): Promise<string | null> {
    const page = await bb.sdk.threads.events.list({
      threadId,
      limit: String(RATE_LIMIT_PAGE),
      order: "desc",
      types: ["provider/rateLimits/updated"],
    });
    return rateLimitStatusFrom(
      page.flatMap((row) => (row.type === "provider/rateLimits/updated" ? [row] : [])),
      providerId,
    );
  }

  /**
   * Gather every signal about a dead thread. `error` alone is not enough — it
   * is null on every real limit failure (see isLimitFailure) — so unless it
   * settles the question on its own, read the thread's own event stream.
   *
   * This asked `threads.rateLimitRecovery()` until 2026-08-21. bb 0.39.0
   * removed that method (get-bb/bb#1623) and the call had been throwing since
   * 2026-08-19T05:40Z — into the catch below, which returned a signal with no
   * rate-limit state in it. `isLimitFailure` then said no to everything, so
   * BOTH detection paths went quiet: 245 limit failures were caught in the ten
   * days before, and none in the two days after. The warning was the only
   * trace, 196 of them, and it is the reason this was findable at all.
   */
  async function inspectFailure(
    threadId: string,
    error: string | null,
    providerId: string,
  ): Promise<LimitFailureSignal> {
    if (isLimitError(error)) return { error };
    try {
      return { error, rateLimitStatus: await latestRateLimitStatus(threadId, providerId) };
    } catch (e) {
      // Expected for a thread bb can no longer read — a deleted thread answers
      // not-found rather than a page of events. Nothing to adopt.
      bb.log.warn(`limit inspection failed for ${threadId}: ${e instanceof Error ? e.message : e}`);
      return { error };
    }
  }

  /**
   * Find limit-failed threads the event stream never reported.
   *
   * Belt and braces, deliberately: the store is fed by thread.failed, and on
   * 2026-08-11 that one dependency turned out to have been broken since the
   * plugin's first commit — silently, with no alarm, because a store that is
   * never written looks exactly like a machine with nothing stuck. This runs
   * every watch tick so the same shape of failure is survivable next time.
   */
  async function reconcile(giveUpAfterSec: number): Promise<void> {
    try {
      const res = (await bb.sdk.threads.list({ archived: false })) as unknown;
      const rows = (Array.isArray(res) ? res : ((res as { threads?: unknown[] })?.threads ?? [])) as ListedThread[];
      const tracked = await stuckThreadsStore.list();
      const inspected = (await bb.storage.kv.get<Record<string, number>>("adoption-inspected")) ?? {};
      const plan = planAdoption(rows, tracked.map((r) => r.threadId), inspected, Date.now(), giveUpAfterSec);
      // Persist BEFORE inspecting: a crash mid-loop must not leave a thread
      // eligible for re-inspection on every tick forever.
      await bb.storage.kv.set("adoption-inspected", plan.retain);

      for (const threadId of plan.inspect) {
        const row = rows.find((t) => t.id === threadId);
        const providerId = (row as unknown as { providerId?: string })?.providerId ?? "claude-code";
        const signal = await inspectFailure(threadId, null, providerId);
        if (!isLimitFailure(signal)) continue;
        bb.log.info(`adopted untracked stuck thread ${threadId} (${describeSignal(signal)}) — the event never reached us`);
        await sweeper.onLimitFailure(threadId, providerId);
      }
    } catch (e) {
      bb.log.warn(`reconcile failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Which signal actually caught this failure — the line that was missing all night. */
  const describeSignal = (s: LimitFailureSignal): string =>
    isLimitError(s.error) ? `error: ${s.error}` : `rate limits ${s.rateLimitStatus ?? "unknown"}`;

  // ── Placement: where should work START? ──────────────────────────────────
  //
  // WHAT BB ACTUALLY EXPOSES, because the shape of this follows from it:
  // there is NO pre-spawn hook. `thread.created` fires AFTER the row exists,
  // its handler returns void, and nothing a plugin returns can rewrite or
  // refuse a spawn. There is also no per-thread account: one Keychain means
  // the whole machine bills one slot at a time. So "route this spawn to
  // account X" is not a thing that can be built — the nearest true thing is
  // "before this thread's first turn burns anything, check the slot the
  // machine is on can hold its model, and move the machine if it cannot".
  //
  // That leaves a real race: the provider process starts moments after the
  // row, and a Keychain swap is only picked up when it starts. Most spawns
  // land after the check, some will not. `bb accounts place` is the reliable
  // half — an orchestrator about to fan out asks FIRST, then spawns.
  async function planFor(model: string | null): Promise<{
    plan: PlacementPlan;
    accounts: Account[];
    active: Account | null;
    polledAt: number | null;
    weight: number;
  }> {
    const { switchAt, weeklyAt, placementMinUnits, placementPinMin } = await settings.get();
    const { polledAt, accounts } = await readUsage();
    const { weights } = readModelWeights(db);
    const active = accounts.find((a) => a.active) ?? null;
    // An EXPLICIT choice is a human act this plugin recorded: `bb accounts
    // switch`, `bb accounts auto`, `bb accounts place --switch`. A switch the
    // watch tick or the reactive path made is not one, and neither is the
    // Python poller's — it leaves no record here at all, which is the correct
    // answer for the same reason: nobody chose it.
    const last = await bb.storage.kv.get<{ at: number; to: string; reason: string }>("last-switch");
    const pinned =
      !!last &&
      !!active &&
      last.to === active.slot &&
      /^manual/.test(last.reason) &&
      Date.now() - last.at < Number(placementPinMin) * 60_000;
    const weight = weightForModel(model, weights);
    const plan = planPlacement({
      accounts: accounts.map((a) => ({
        slot: a.slot,
        fiveUtil: a.fiveHour,
        sevenUtil: a.sevenDay,
        active: a.active,
      })),
      modelWeight: weight,
      activeSlot: active?.slot ?? null,
      activePinned: pinned,
      switchAt: Number(switchAt),
      weeklyAt: Number(weeklyAt),
      minUnits: Number(placementMinUnits),
      model: model ?? undefined,
    });
    return { plan, accounts, active, polledAt, weight };
  }

  /** The model a thread will run on, or null when bb cannot say yet. */
  async function modelOf(threadId: string): Promise<string | null> {
    try {
      const exec = (await bb.sdk.threads.defaultExecutionOptions({ threadId })) as { model?: string };
      return exec?.model ? String(exec.model) : null;
    } catch {
      return null;
    }
  }

  bb.events.on("thread.created", ({ thread }) => {
    void (async () => {
      const { autoSwitch, placeOnSpawn } = await settings.get();
      if (!autoSwitch || !placeOnSpawn) return;
      // Only Claude threads bill these accounts; a codex thread is none of our
      // business and must not be allowed to move the machine.
      if (!/claude/i.test(thread.providerId)) return;

      const model = await modelOf(thread.id);
      const { plan, accounts, active, polledAt } = await planFor(model);
      if (plan.action === "none") return;
      // Every guard the watch tick uses, for the same reasons — a stale cache
      // or a slot we cannot confirm is not grounds for moving the machine, and
      // the cooldown is what stops a fan-out of ten spawns switching ten times.
      if (await isStale(polledAt)) {
        bb.log.debug(`placement for ${thread.id}: usage cache stale, skipping`);
        return;
      }

      if (plan.action === "warn") {
        bb.log.warn(`placement(${thread.id}): ${plan.reason}`);
        // Log every time; interrupt a human at most once a quarter hour. A
        // notification per spawn during a fan-out teaches him to ignore them.
        const lastWarn = (await bb.storage.kv.get<{ at: number }>("last-placement-warn"))?.at ?? 0;
        if (Date.now() - lastWarn > 15 * 60_000) {
          await bb.storage.kv.set("last-placement-warn", { at: Date.now() });
          await notify("Claude: new thread on a full account", plan.reason);
        }
        return;
      }

      if (!active || !(await activeSlotIsTrustworthy(active.slot))) return;
      if (await underCooldown()) {
        bb.log.info(`placement for ${thread.id} wanted ${plan.to} but a switch is under cooldown — leaving it`);
        return;
      }
      const target = accounts.find((a) => a.slot === plan.to);
      if (!target) return;
      const ok = await switchTo(target, active.slot, `${plan.reason} (thread ${thread.id})`);
      if (!ok) return;
      // A switch frees capacity for everything that was stuck on the old slot,
      // exactly as the proactive path does.
      const swept = await sweeper.sweep("placement");
      if (swept.continued.length) bb.log.info(`placement switch to ${target.slot} resumed: ${swept.continued.join(", ")}`);
    })();
  });

  // Reactive path — the optimization ladder. Goal: maximize usage across all
  // accounts × model tiers; never leave window tokens stranded.
  //
  // A rate-limited thread is the ground-truth signal (there is NO Fable-specific
  // usage bucket in the API — learned 2026-08-09). Ladder:
  //   1. Failing model is Fable AND the account's overall 5h window is still
  //      under switchAt → only Fable's own ceiling was hit. DON'T burn a fresh
  //      account: continue the thread on downgradeModel (Opus) so the rest of
  //      the window gets used. Record the observed ceiling for the optimizer.
  //   2. Otherwise the whole window (or a non-Fable limit) is gone → switch to
  //      the lowest-usage fresh account and auto-continue the thread there.
  bb.events.on("thread.failed", ({ thread, error }) => {
    void (async () => {
      const signal = await inspectFailure(thread.id, error, thread.providerId);
      if (!isLimitFailure(signal)) return;
      bb.log.info(`thread ${thread.id} failed on a provider limit (${describeSignal(signal)}) — tracking for recovery`);
      // Track this thread as stuck regardless of what happens below — a
      // fable-downgrade or a switch that itself fails must not lose it.
      await sweeper.onLimitFailure(thread.id, thread.providerId);
      const { autoSwitch, switchAt, downgradeModel } = await settings.get();
      if (!autoSwitch || (await underCooldown())) return;
      const { accounts } = await readUsage();
      const active = accounts.find((a) => a.active);

      let failingModel = "";
      try {
        const exec = (await bb.sdk.threads.defaultExecutionOptions({ threadId: thread.id })) as { model?: string };
        failingModel = String(exec?.model ?? "");
      } catch { /* model unknown — fall through to account switch */ }

      const fiveH = active?.fiveHour ?? 100;
      if (/fable/i.test(failingModel) && fiveH < Number(switchAt)) {
        const ceilings = (await bb.storage.kv.get<object[]>("fable-ceilings")) ?? [];
        await bb.storage.kv.set("fable-ceilings", [
          ...ceilings.slice(-49),
          { at: Date.now(), slot: active?.slot ?? "?", overallFiveHour: fiveH },
        ]);
        try {
          await bb.sdk.threads.send({
            threadId: thread.id,
            mode: "auto",
            model: downgradeModel,
            input: [{
              type: "text",
              mentions: [],
              text: `[accounts] Fable 5 hit its model-specific limit (account overall 5h at ${fiveH}% — window still has room). Continuing this thread on ${downgradeModel} to use the remaining tokens. Please continue from where you left off.`,
            }],
          });
          bb.log.info(`thread ${thread.id}: Fable ceiling at overall ${fiveH}% — downgraded to ${downgradeModel} on ${active?.slot} (no account switch)`);
          bb.realtime.publish("accounts.switched", { from: "fable-5", to: downgradeModel, reason: `model downgrade on ${active?.slot}, window at ${fiveH}%` });
        } catch (e) {
          bb.log.warn(`model-downgrade continue failed for ${thread.id}: ${e instanceof Error ? e.message : e}`);
        }
        return;
      }

      const best = await pickBest(active?.slot ?? "");
      if (!best) {
        bb.log.warn(`thread ${thread.id} rate-limited but no fresh alternative slot — leaving to provider-retry`);
        return;
      }
      const ok = await switchTo(best, active?.slot ?? "?", `reactive: thread ${thread.id} hit a provider rate limit on ${failingModel || "unknown model"} with window at ${fiveH}%`);
      if (!ok) return;
      // Sweeps thread.id itself plus every other currently-stuck thread —
      // replaces the old single-thread recovery dance, which never revisited
      // threads that failed earlier.
      const swept = await sweeper.sweep("reactive");
      if (swept.continued.length) bb.log.info(`reactive switch to ${best.slot} resumed: ${swept.continued.join(", ")}`);
    })();
  });

  bb.rpc.register(rpcContract, {
    async forecast() {
      return (await currentForecast()) ?? null;
    },
    async analytics({ days }) {
      const now = Math.floor(Date.now() / 1000);
      const since = now - Math.max(1, days) * 86400;
      const offsetSec = -new Date().getTimezoneOffset() * 60;
      return {
        days,
        coverage: transcriptCoverage(db),
        byModel: burnBy(db, "model", since),
        byAgent: mergeByKey(burnBy(db, "entrypoint", since).map((x) => ({ ...x, key: agentShape(x.key) }))),
        byRepo: burnBy(db, "repo", since).slice(0, 12),
        byProject: mergeByKey(
          burnBy(db, "project", since).map((x) => ({ ...x, key: prettyProject(x.key) })),
        ).slice(0, 12),
        byHourOfWeek: burnByHourOfWeek(db, since, offsetSec),
      };
    },
    async status() {
      // ONE read. The capacity verdict and the rows beside it have to be the
      // same observation — MX-218 fixed exactly this in the outage command,
      // where a second readUsage() let the verdict and the account list come
      // from different polls and disagree on screen.
      const { polledAt, accounts } = await readUsage();
      const { weeklyAt } = await settings.get();
      const lastSwitch =
        (await bb.storage.kv.get<{ at: number; from: string; to: string; reason: string }>("last-switch")) ?? null;
      return {
        polledAt,
        stale: await isStale(polledAt),
        accounts,
        capacity: await capacityOf(polledAt, accounts, Number(weeklyAt)),
        lastSwitch,
      };
    },
  });

  bb.cli.register({
    name: "accounts",
    summary: "Claude Max account usage and switching (auto-switch on limits)",
    commands: [
      { name: "list", summary: "Per-account 5h/7d utilization (default)", usage: "bb accounts [list]" },
      { name: "switch", summary: "Switch the live Claude credentials to a slot", usage: "bb accounts switch <slot>" },
      { name: "auto", summary: "Run one auto-switch evaluation now", usage: "bb accounts auto" },
      { name: "log", summary: "Recent switch decisions", usage: "bb accounts log" },
      {
        name: "place",
        summary: "Where should work on this model START? Ask BEFORE spawning a thread",
        usage: "bb accounts place [--model M] [--switch] [--json]",
      },
      {
        name: "outage",
        summary:
          "Can this machine serve AT ALL — free window or paid credits? (exit 0 = no, 1 = yes, 2 = cannot tell)",
        usage: "bb accounts outage [--json]",
      },
      { name: "forecast", summary: "When every account runs dry, and for how long", usage: "bb accounts forecast [--json]" },
      { name: "stats", summary: "Where the quota went, by model/agent/project/hour", usage: "bb accounts stats [--days N] [--json]" },
      { name: "history", summary: "Recorded utilization history", usage: "bb accounts history [--slot S] [--days N] [--json]" },
      { name: "reindex", summary: "Scan Claude Code transcripts now instead of waiting for the schedule", usage: "bb accounts reindex" },
      {
        name: "build",
        summary: "Which commit this RUNNING process was loaded from (not the checkout)",
        usage: "bb accounts build [--json]",
      },
    ],
    async run(argv) {
      const cmd = argv[0] ?? "list";
      const json = argv.includes("--json");

      // Deliberately answered BEFORE anything else touches the db or the usage cache:
      // "what is running" must stay answerable when the thing running is broken.
      if (cmd === "build") {
        if (json) return { exitCode: 0, stdout: JSON.stringify(BUILD_STAMP) };
        const rev = BUILD_STAMP.rev ?? "unknown";
        const dirty = BUILD_STAMP.dirty === null ? "" : BUILD_STAMP.dirty ? " +dirty" : "";
        const why = BUILD_STAMP.why ? `  (${BUILD_STAMP.why})` : "";
        return {
          exitCode: 0,
          stdout: `loaded ${rev}${dirty} from ${BUILD_STAMP.sourceDir} at ${BUILD_STAMP.loadedAt}${why}`,
        };
      }
      const flag = (name: string, fallback: number): number => {
        const i = argv.indexOf(`--${name}`);
        const v = i >= 0 ? Number(argv[i + 1]) : Number.NaN;
        return Number.isFinite(v) && v > 0 ? v : fallback;
      };
      const clock = (t: number | null): string =>
        t === null ? "—" : new Date(t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

      if (cmd === "forecast") {
        const fc = await currentForecast();
        if (!fc) return { exitCode: 1, stderr: "no accounts in the usage cache" };
        if (json) return { exitCode: 0, stdout: JSON.stringify(fc) };
        const lines: string[] = [];
        if (fc.confidence === "stale") {
          lines.push("⚠ STALE — the usage cache is behind; check the claude.usage-poll LaunchAgent.");
        }
        if (fc.confidence === "provisional") {
          // Deliberately WITHOUT the times. A forecast off seven samples taken
          // during one burst reads as authoritative if it is printed in the
          // usual shape, and being confidently wrong by an order of magnitude
          // is worse than saying nothing yet.
          const { distinctPolls, neededPolls, demandSamples = 0 } = fc.coverage;
          const pct = Math.min(100, Math.round((distinctPolls / neededPolls) * 100));
          lines.push(
            `⚠ NOT ENOUGH HISTORY YET — ${distinctPolls}/${neededPolls} polls recorded (${pct}%), ` +
              `${demandSamples} usable demand sample(s).`,
          );
          lines.push("   Recording started today; a blackout forecast needs about 3 days of polls to mean anything.");
          lines.push("   Run `bb accounts stats` for the retroactive breakdowns, which are ready now.");
          return { exitCode: 0, stdout: lines.join("\n") };
        }
        lines.push(
          fc.blackout.likely === null
            ? `no blackout forecast in the next ${Math.round(fc.horizonSec / 86400)} days`
            : `all accounts dry ~${clock(fc.blackout.likely)} (${clock(fc.blackout.earliest)} – ${clock(fc.blackout.latest)})` +
              `, back ~${clock(fc.blackout.endsAt)}`,
        );
        if (fc.blackout.expectedSec > 0) {
          lines.push(`expected downtime over the horizon: ${(fc.blackout.expectedSec / 3600).toFixed(1)}h`);
        }
        for (const [slot, at] of Object.entries(fc.weeklyExhaustedAt)) {
          lines.push(`  ${slot.padEnd(24)} weekly window exhausted ${at === null ? "not within horizon" : clock(at)}`);
        }
        lines.push("");
        lines.push("blackout hours per week by account count:");
        for (const p of fc.slotCurve) {
          lines.push(`  ${String(p.slots).padStart(2)} slots  ${p.blackoutHoursPerWeek.toFixed(1)}h`);
        }
        return { exitCode: 0, stdout: lines.join("\n") };
      }

      if (cmd === "reindex") {
        try {
          const summary = await indexTranscripts();
          return summary === null
            ? { exitCode: 0, stdout: "an index run is already in flight" }
            : { exitCode: 0, stdout: summary };
        } catch (e) {
          return { exitCode: 1, stderr: `reindex failed: ${e instanceof Error ? e.message : e}` };
        }
      }

      if (cmd === "stats") {
        const days = flag("days", 7);
        const now = Math.floor(Date.now() / 1000);
        const since = now - days * 86400;
        const offsetSec = -new Date().getTimezoneOffset() * 60;
        const payload = {
          days,
          coverage: transcriptCoverage(db),
          byModel: burnBy(db, "model", since),
          byAgent: mergeByKey(burnBy(db, "entrypoint", since).map((s) => ({ ...s, key: agentShape(s.key) }))),
          byRepo: burnBy(db, "repo", since).slice(0, 15),
          repoSources: repoResolutionSources(db),
          byProject: mergeByKey(
            burnBy(db, "project", since).map((s) => ({ ...s, key: prettyProject(s.key) })),
          ).slice(0, 15),
          byHourOfWeek: burnByHourOfWeek(db, since, offsetSec),
          weights: readModelWeights(db),
        };
        if (json) return { exitCode: 0, stdout: JSON.stringify(payload) };
        const section = (title: string, slices: { key: string; messages: number; weightedK: number }[]) => {
          const total = slices.reduce((s, x) => s + x.weightedK, 0) || 1;
          return [
            `${title}:`,
            ...slices.slice(0, 8).map((s) => {
              const pct = (s.weightedK / total) * 100;
              const n = Math.round(pct / 5);
              return `  ${s.key.slice(0, 30).padEnd(31)}${"█".repeat(n).padEnd(20)} ${pct.toFixed(1).padStart(5)}%  ${Math.round(s.weightedK).toLocaleString()}k`;
            }),
            "",
          ];
        };
        const out = [
          `last ${days} day(s) — ${payload.coverage.messages.toLocaleString()} messages recorded`,
          "",
          ...section("by model", payload.byModel),
          ...section("by who spent it", payload.byAgent),
          ...section("by repo", payload.byRepo),
          ...section("by directory", payload.byProject),
        ];
        return { exitCode: 0, stdout: out.join("\n") };
      }

      if (cmd === "history") {
        const days = flag("days", 2);
        const now = Math.floor(Date.now() / 1000);
        const since = now - days * 86400;
        const slotArg = argv.indexOf("--slot") >= 0 ? argv[argv.indexOf("--slot") + 1] : null;
        const { accounts } = await readUsage();
        const slots = slotArg ? [slotArg] : accounts.map((a) => a.slot);
        const series = slots.map((slot) => ({ slot, samples: readSamplesFor(slot, since) }));
        if (json) return { exitCode: 0, stdout: JSON.stringify({ days, series }) };
        const spark = (values: number[]) => {
          const chars = "▁▂▃▄▅▆▇█";
          return values.map((v) => chars[Math.min(7, Math.max(0, Math.round((v / 100) * 7)))]).join("");
        };
        const lines = series.map((s) => {
          if (s.samples.length === 0) return `${s.slot.padEnd(24)} (no history recorded yet)`;
          // Downsample so a 2-day series fits a terminal line.
          const step = Math.max(1, Math.ceil(s.samples.length / 60));
          const five = s.samples.filter((_, i) => i % step === 0).map((x) => x.fiveUtil ?? 0);
          return `${s.slot.padEnd(24)} 5h ${spark(five)} now ${s.samples[s.samples.length - 1]!.fiveUtil ?? 0}%`;
        });
        lines.push("", `${series.reduce((n, s) => n + s.samples.length, 0)} samples over ${days} day(s)`);
        return { exitCode: 0, stdout: lines.join("\n") };
      }

      if (cmd === "switch") {
        const slot = argv[1];
        if (!slot) return { exitCode: 1, stderr: "usage: bb accounts switch <slot>" };
        const { accounts } = await readUsage();
        const target = accounts.find((a) => a.slot === slot);
        if (!target) return { exitCode: 1, stderr: `unknown slot '${slot}' — bb accounts list` };
        const active = accounts.find((a) => a.active);
        const ok = await switchTo(target, active?.slot ?? "?", "manual via bb accounts switch");
        return ok ? { exitCode: 0, stdout: `switched to ${slot}` } : { exitCode: 1, stderr: "switch failed — see bb plugin logs accounts" };
      }
      if (cmd === "auto") {
        const { switchAt } = await settings.get();
        const { accounts } = await readUsage();
        const active = accounts.find((a) => a.active);
        if (!active) return { exitCode: 1, stderr: "no active account in usage cache" };
        if ((active.fiveHour ?? 0) < Number(switchAt)) {
          return { exitCode: 0, stdout: `active ${active.slot} at ${active.fiveHour}% 5h — below ${switchAt}%, no switch` };
        }
        const best = await pickBest(active.slot);
        if (!best) return { exitCode: 1, stderr: "no fresh alternative slot" };
        const ok = await switchTo(best, active.slot, "manual auto-evaluation");
        return ok ? { exitCode: 0, stdout: `switched to ${best.slot}` } : { exitCode: 1, stderr: "switch failed" };
      }
      // The pre-spawn consult, and the ONLY placement path with no race in it:
      // bb has no pre-spawn hook, so an orchestrator that wants its fan-out to
      // land somewhere specific asks here first and spawns second.
      //
      //   bb accounts place --model claude-fable-5 --switch && bb thread spawn ...
      //
      // Without --switch this only reports. That is deliberate: the caller
      // keeps the decision, which is the same rule the automatic path follows
      // when a human has chosen the account by hand.
      if (cmd === "place") {
        const i = argv.indexOf("--model");
        const model = i >= 0 ? (argv[i + 1] ?? null) : null;
        const { plan, accounts, active, polledAt, weight } = await planFor(model);
        const stale = await isStale(polledAt);
        const wants = plan.action === "switch";
        let switched = false;
        if (wants && argv.includes("--switch")) {
          const target = accounts.find((a) => a.slot === plan.to);
          if (!target || !active) return { exitCode: 1, stderr: `cannot switch: ${plan.to} not in the usage cache` };
          switched = await switchTo(target, active.slot, `manual via bb accounts place (${model ?? "unspecified model"})`);
          if (!switched) return { exitCode: 1, stderr: "switch failed — see bb plugin logs accounts" };
        }
        if (json) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              model,
              modelWeight: weight,
              active: active?.slot ?? null,
              stale,
              action: plan.action,
              recommended: plan.to ?? (plan.action === "none" ? (active?.slot ?? null) : null),
              reason: plan.reason,
              switched,
            }),
          };
        }
        const lines = [
          `model     ${model ?? "(unspecified — priced as 'other')"}`,
          `active    ${active?.slot ?? "(none)"}`,
          `verdict   ${plan.action}${plan.to ? ` -> ${plan.to}` : ""}`,
          `           ${plan.reason}`,
        ];
        if (switched) lines.push(`switched  ${active?.slot} -> ${plan.to}`);
        else if (wants) lines.push(`           re-run with --switch to move the machine there`);
        if (stale) lines.push("⚠ usage cache is stale — check the claude.usage-poll LaunchAgent");
        // A capped fleet is the one case where the exit code should be usable
        // as a gate: a spawn loop can stop rather than start work that cannot run.
        return { exitCode: plan.action === "warn" && plan.to === null ? 2 : 0, stdout: lines.join("\n") };
      }
      // The away-message question, for a SCHEDULED caller that wants a cheap,
      // unambiguous answer and no prose to parse. Exit codes are the contract:
      //   0  the machine CANNOT SERVE AT ALL, confirmed over N distinct
      //      non-stale polls — no free window anywhere and no credits open
      //   1  the machine can serve. Includes PAID-ONLY, which runs and bills
      //   2  cannot tell — stale poll, an unreadable account, or an outage too
      //      young to have been confirmed
      // so `if bb accounts outage >/dev/null; then ...` speaks only on 0, and
      // both flavours of doubt fall to silence.
      //
      // MX-218 (mgrin, 2026-08-21) is what "cannot serve at all" is doing in
      // that list. It used to be "no free window", so exit 0 fired on a machine
      // billing happily to credits. The headline, `cannotServe` and the exit
      // code now come from one function over one verdict — reading any single
      // one of them is safe, which is the whole ask.
      if (cmd === "outage") {
        const o = await currentOutage();
        const v = o.verdict;
        const { headline, exitCode } = outageSignals(v, o.confirmed);
        if (json) {
          return {
            exitCode,
            stdout: JSON.stringify({
              confirmed: o.confirmed,
              // THE boolean. True only when nothing can serve by any means.
              cannotServe: v.cannotServe,
              // The fact that used to be called `allExhausted` and used to BE
              // the verdict. Still true, still worth knowing, no longer a
              // reason to stop: with credits on it is a statement about money.
              // Renamed rather than redefined so a consumer still reading the
              // old key gets `undefined` — loud — instead of a boolean that
              // quietly means something else.
              allFreeWindowsSpent: v.allFreeWindowsSpent,
              capacity: v.capacity,
              earliestUsableAt: v.earliestUsableAt,
              earliestUsableSlot: v.earliestUsableSlot,
              unknownReason: v.unknownReason,
              reason: v.reason,
              consecutivePolls: o.streak.consecutive,
              requiredPolls: o.requiredPolls,
              outageSincePolledAt: o.streak.sincePolledAt,
              polledAt: o.polledAt,
              stale: o.stale,
              accounts: v.accounts,
            }),
          };
        }
        const lines = [
          `verdict   ${headline}`,
          `reason    ${v.reason}`,
          `capacity  ${v.capacity}${v.capacity === "paid-only" ? " — usable, and it BILLS" : ""}`,
          `free      ${v.allFreeWindowsSpent ? `no free window on any of ${v.accounts.length} account(s)` : "at least one account has a free window"}`,
          // The free window coming back, which is a different question from
          // whether the machine is working. Named on the line so the two do not
          // get read as one again.
          `back      ${v.earliestUsableAt ?? (v.allFreeWindowsSpent ? "UNKNOWN — no reset time on a binding window" : "—")}${v.earliestUsableSlot ? ` (${v.earliestUsableSlot})` : ""}`,
          `polls     ${o.streak.consecutive}/${o.requiredPolls} consecutive`,
        ];
        for (const a of v.accounts) {
          lines.push(
            `  ${a.slot.padEnd(24)} ${a.exhausted ? `out on ${a.binding.join("+")} until ${a.usableAt ?? "UNKNOWN"}` : "usable"}`,
          );
        }
        return { exitCode, stdout: lines.join("\n") };
      }
      if (cmd === "log") {
        const last = await bb.storage.kv.get<{ at: number; from: string; to: string; reason: string }>("last-switch");
        return {
          exitCode: 0,
          stdout: last
            ? `${new Date(last.at).toISOString()} ${last.from} -> ${last.to}: ${last.reason}`
            : "no switches recorded by this plugin yet",
        };
      }
      const { polledAt, accounts } = await readUsage();
      const stale = await isStale(polledAt);
      // --json is the Übersicht widget's feed (dash-claude-usage). The widget
      // used to read the poller's cache file directly, which meant the desktop
      // could show a different active account than bb was actually billing.
      // One surface, one answer.
      if (argv.includes("--json")) {
        // `outage` rides along on the payload the widget already reads, from
        // the SAME poll as the accounts beside it — a consumer that has this
        // JSON never has to shell out twice or re-derive the predicate.
        const o = await currentOutage({ polledAt, accounts });
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            polledAt,
            stale,
            active: accounts.find((a) => a.active)?.slot ?? null,
            outage: {
              confirmed: o.confirmed,
              cannotServe: o.verdict.cannotServe,
              allFreeWindowsSpent: o.verdict.allFreeWindowsSpent,
              earliestUsableAt: o.verdict.earliestUsableAt,
              earliestUsableSlot: o.verdict.earliestUsableSlot,
              unknownReason: o.verdict.unknownReason,
              reason: o.verdict.reason,
              consecutivePolls: o.streak.consecutive,
              requiredPolls: o.requiredPolls,
            },
            // free / paid-only / none / unknown. The widget's whole reason to
            // show credits is that spend nobody can see is spend nobody will
            // notice — so the verdict rides on the payload it already reads,
            // from the same poll as the accounts beside it.
            capacity: o.verdict.capacity,
            accounts: accounts.map((a) => ({
              slot: a.slot,
              email: a.email,
              active: a.active,
              fiveHour: { util: a.fiveHour, resetsAt: a.fiveHourResetsAt },
              sevenDay: { util: a.sevenDay, resetsAt: a.sevenDayResetsAt },
              credits: a.credits,
              creditSpend: a.creditSpend,
            })),
          }),
        };
      }
      const bar = (v: number | null) => {
        const f = Math.min(1, (v ?? 0) / 100);
        const n = Math.round(f * 12);
        return "█".repeat(n) + "░".repeat(12 - n);
      };
      // Credit state per account, never a machine-wide flag: credits are on
      // ONE of four slots, and a summary line would be wrong for the other
      // three. "?" is UNKNOWN — a poll that failed, not an account without
      // credits.
      const creditCell = (a: Account) => {
        if (a.credits === "unknown") return "  credits ?";
        if (a.credits !== "on") return "";
        const sp = a.creditSpend;
        if (!sp || sp.used === null) return "  CREDITS ON";
        const cap = sp.limit === null ? "" : `/${sp.limit.toFixed(2)}`;
        return `  CREDITS ${sp.used.toFixed(2)}${cap}${sp.currency ? ` ${sp.currency}` : ""}`;
      };
      const lines = accounts.map(
        (a) =>
          `${a.active ? "▶" : " "} ${a.slot.padEnd(24)} 5h ${bar(a.fiveHour)} ${String(a.fiveHour ?? 0).padStart(3)}%  7d ${bar(a.sevenDay)} ${String(a.sevenDay ?? 0).padStart(3)}%${creditCell(a)}`,
      );
      if (!stale && accounts.length > 0) {
        const v = capacityVerdict(accounts, Number(recoverySettings.weeklyAt));
        if (v === "paid-only") lines.push("⚠ no free window on any account — work here BILLS to usage credits");
        if (v === "none") lines.push("⚠ every account is walled and no credits are enabled");
      }
      if (stale) lines.push("⚠ usage cache is stale — check the claude.usage-poll LaunchAgent");
      return { exitCode: 0, stdout: lines.join("\n") || "no accounts captured (claude-acct capture)" };
    },
  });

  bb.log.info("accounts plugin loaded");
}
