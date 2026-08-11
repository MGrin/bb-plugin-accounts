// bb-plugin-accounts — Claude Max account switching inside bb.
//
// The standalone Python poller (claude.usage-poll LaunchAgent) keeps polling
// Anthropic's usage endpoint for every captured account and owns the Keychain
// swap (`claude-acct use <slot>`). This plugin is the brain and the surface on
// top of it:
//  - reads ~/.config/claude-usage/usage.json (the poller's cache)
//  - `bb accounts` CLI + homepage usage tiles
//  - schedule: proactive switch when the ACTIVE slot crosses switchAt (default
//    85 — Fable 5 hits its wall before the reported 5h window reaches 95;
//    learned 2026-08-09) to the freshest lowest-usage slot
//  - thread.failed: a provider rate-limit failure IS the trigger — switch
//    immediately and auto-continue the failed thread via the SDK's
//    rate-limit-recovery path. Utilization thresholds can lie; the 429 doesn't.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
// The judgement lives in lib.ts so `node --test` can exercise it without a
// Keychain, a poller or a clock. A second copy here is how the two drift.
import {
  createRecoverySweeper,
  decideSwitch,
  isLimitError,
  isLimitFailure,
  type LimitFailureSignal,
  type ListedThread,
  pickBest as pickBestOf,
  planAdoption,
  type PrevSample,
  type RecoveryAttemptResult,
  shouldNudgeAfterIneligible,
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
import { MIGRATIONS } from "./analytics/schema.ts";
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
  writeCursor,
  writeModelWeights,
  writeTranscriptRows,
} from "./analytics/store.ts";

const run = promisify(execFile);
const USAGE = `${os.homedir()}/.config/claude-usage/usage.json`;
const CLAUDE_ACCT = `${os.homedir()}/.local/bin/claude-acct`;

const accountShape = z.object({
  slot: z.string(),
  email: z.string(),
  active: z.boolean(),
  fiveHour: z.number().nullable(),
  sevenDay: z.number().nullable(),
  fiveHourResetsAt: z.string().nullable(),
  sevenDayResetsAt: z.string().nullable(),
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
      byHourOfWeek: z.array(z.object({ dayOfWeek: z.number(), hour: z.number(), weightedK: z.number() })),
    }),
  },
  status: {
    input: z.null(),
    output: z.object({
      polledAt: z.number().nullable(),
      stale: z.boolean(),
      accounts: z.array(accountShape),
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
  }[];
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
    weeklyAt: { type: "string", label: "7d utilization % that triggers a switch (and caps destinations)", default: "95" },
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
    recoveryMaxAttempts: { type: "string", label: "Give up resuming a thread after this many failed attempts (0 = unlimited)", default: "5" },
    recoveryGiveUpAfterHours: { type: "string", label: "Give up resuming a thread this long after it first got stuck (0 = never)", default: "6" },
  });

  // Analytics storage. Opened once at load; the host tracks the handle and
  // closes it on dispose/reload. Migrations are append-only — see schema.ts.
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);

  const isStale = async (polledAt: number | null) => {
    const { staleAfterMin } = await settings.get();
    return polledAt === null || Date.now() / 1000 - polledAt > Number(staleAfterMin) * 60;
  };

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
    async attemptContinue(threadId): Promise<RecoveryAttemptResult> {
      try {
        const status = await bb.sdk.threads.rateLimitRecovery({ threadId });
        if (status.reason === "eligible" && status.candidate) {
          await new Promise((r) => setTimeout(r, 3000));
          await bb.sdk.threads.continueAfterRateLimit({ threadId, failedRequestId: status.candidate.failedRequestId });
          return { outcome: "continued" };
        }
        // bb has no replayable candidate. That is not the same as "unrecoverable":
        // thr_3waqz7vb9w sat dead for ten hours on 2026-08-11 with reason
        // "no-rate-limit-state", because its limit arrived as an agentMessage
        // rather than a stored failed request. A plain follow-up message — what
        // a human would send — started it again immediately.
        if (!shouldNudgeAfterIneligible(status.reason)) {
          return { outcome: "not-eligible", reason: status.reason };
        }
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
              "bb had no replayable request for it, so this is a plain restart rather than a retry of the failed call. " +
              "Continue from where you left off — re-check anything whose result you never saw before acting on it.",
          }],
        });
        bb.log.info(`recovery: nudged ${threadId} back to life (bb reason: ${status.reason})`);
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
  async function anyAccountHasCapacity(): Promise<boolean> {
    const { polledAt, accounts } = await readUsage();
    if (accounts.length === 0 || (await isStale(polledAt))) return true;
    const weeklyAt = Number(recoverySettings.weeklyAt);
    return accounts.some((a) => (a.fiveHour ?? 100) < 100 && (a.sevenDay ?? 100) < weeklyAt);
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
  function nextCapacityAt(accounts: Account[]): Date | null {
    const times = accounts
      .map((a) => (a.fiveHourResetsAt ? Date.parse(a.fiveHourResetsAt) : NaN))
      .filter((t) => !Number.isNaN(t) && t > Date.now())
      .sort((a, b) => a - b);
    return times.length ? new Date(times[0]!) : null;
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
    const next = nextCapacityAt(accounts);
    const stuck = (await stuckThreadsStore.list()).length;
    const eta = next
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
    const { autoSwitch, switchAt, weeklyAt, spreadMargin, cooldownSec, spreadCooldownSec } = await settings.get();
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
      const cov = transcriptCoverage(db);
      return (
        `indexed ${written} new message(s) from ${result.filesRead}/${result.filesSeen} transcript(s) ` +
        `in ${Math.round((Date.now() - startedAt) / 1000)}s — ${cov.messages} total`
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
   * Gather every signal about a dead thread. `error` alone is not enough — it
   * is null on every real limit failure (see isLimitFailure) — so unless it
   * settles the question on its own, ask bb's recovery inspection, which
   * carries the provider rate-limit snapshot on every answer including refusals.
   */
  async function inspectFailure(threadId: string, error: string | null): Promise<LimitFailureSignal> {
    if (isLimitError(error)) return { error };
    try {
      const status = await bb.sdk.threads.rateLimitRecovery({ threadId });
      return { error, rateLimitStatus: status.rateLimits?.status ?? null, recoveryReason: status.reason };
    } catch (e) {
      // Expected for a destroyed environment, which answers
      // thread_environment_unavailable rather than a status. Nothing to adopt.
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
        const signal = await inspectFailure(threadId, null);
        if (!isLimitFailure(signal)) continue;
        const providerId = (row as unknown as { providerId?: string })?.providerId ?? "claude-code";
        bb.log.info(`adopted untracked stuck thread ${threadId} (${describeSignal(signal)}) — the event never reached us`);
        await sweeper.onLimitFailure(threadId, providerId);
      }
    } catch (e) {
      bb.log.warn(`reconcile failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Which signal actually caught this failure — the line that was missing all night. */
  const describeSignal = (s: LimitFailureSignal): string =>
    isLimitError(s.error)
      ? `error: ${s.error}`
      : s.rateLimitStatus === "blocked"
      ? `rate limits blocked, bb reason ${s.recoveryReason}`
      : `bb reason ${s.recoveryReason}`;

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
      const signal = await inspectFailure(thread.id, error);
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
      // replaces the old single-thread rateLimitRecovery/continueAfterRateLimit
      // dance, which never revisited threads that failed earlier.
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
        byProject: mergeByKey(
          burnBy(db, "project", since).map((x) => ({ ...x, key: prettyProject(x.key) })),
        ).slice(0, 12),
        byHourOfWeek: burnByHourOfWeek(db, since, offsetSec),
      };
    },
    async status() {
      const { polledAt, accounts } = await readUsage();
      const lastSwitch =
        (await bb.storage.kv.get<{ at: number; from: string; to: string; reason: string }>("last-switch")) ?? null;
      return { polledAt, stale: await isStale(polledAt), accounts, lastSwitch };
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
      { name: "forecast", summary: "When every account runs dry, and for how long", usage: "bb accounts forecast [--json]" },
      { name: "stats", summary: "Where the quota went, by model/agent/project/hour", usage: "bb accounts stats [--days N] [--json]" },
      { name: "history", summary: "Recorded utilization history", usage: "bb accounts history [--slot S] [--days N] [--json]" },
      { name: "reindex", summary: "Scan Claude Code transcripts now instead of waiting for the schedule", usage: "bb accounts reindex" },
    ],
    async run(argv) {
      const cmd = argv[0] ?? "list";
      const json = argv.includes("--json");
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
          ...section("by project", payload.byProject),
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
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            polledAt,
            stale,
            active: accounts.find((a) => a.active)?.slot ?? null,
            accounts: accounts.map((a) => ({
              slot: a.slot,
              email: a.email,
              active: a.active,
              fiveHour: { util: a.fiveHour, resetsAt: a.fiveHourResetsAt },
              sevenDay: { util: a.sevenDay, resetsAt: a.sevenDayResetsAt },
            })),
          }),
        };
      }
      const bar = (v: number | null) => {
        const f = Math.min(1, (v ?? 0) / 100);
        const n = Math.round(f * 12);
        return "█".repeat(n) + "░".repeat(12 - n);
      };
      const lines = accounts.map(
        (a) =>
          `${a.active ? "▶" : " "} ${a.slot.padEnd(24)} 5h ${bar(a.fiveHour)} ${String(a.fiveHour ?? 0).padStart(3)}%  7d ${bar(a.sevenDay)} ${String(a.sevenDay ?? 0).padStart(3)}%`,
      );
      if (stale) lines.push("⚠ usage cache is stale — check the claude.usage-poll LaunchAgent");
      return { exitCode: 0, stdout: lines.join("\n") || "no accounts captured (claude-acct capture)" };
    },
  });

  bb.log.info("accounts plugin loaded");
}
