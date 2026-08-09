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
import { decideSwitch, pickBest as pickBestOf, worst } from "./lib.ts";

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

export const rpcContract = defineRpcContract({
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
    downgradeModel: { type: "string", label: "Model to continue Fable threads on when only Fable's own limit is hit", default: "claude-opus-5[1m]" },
    cooldownSec: { type: "string", label: "Minimum seconds between switches", default: "120" },
    spreadMargin: {
      type: "string",
      label: "Switch early when another slot is this many points roomier (0 = never)",
      default: "25",
    },
    spreadCooldownSec: { type: "string", label: "Minimum seconds between early (spread) switches", default: "1800" },
    staleAfterMin: { type: "string", label: "Treat usage data older than this (min) as stale", default: "15" },
  });

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
  bb.background.schedule("watch", "*/2 * * * *", async () => {
    const { autoSwitch, switchAt, spreadMargin, cooldownSec, spreadCooldownSec } = await settings.get();
    if (!autoSwitch) return;
    const { polledAt, accounts } = await readUsage();
    if (await isStale(polledAt)) return;
    const active = accounts.find((a) => a.active);
    if (!active) return;
    if (!(await activeSlotIsTrustworthy(active.slot))) return;

    const last = await bb.storage.kv.get<{ at: number }>("last-switch");
    const sinceSec = last ? (Date.now() - last.at) / 1000 : Number.POSITIVE_INFINITY;
    const decision = decideSwitch(
      accounts,
      {
        switchAt: Number(switchAt),
        spreadMargin: Number(spreadMargin),
        cooldownSec: Number(cooldownSec),
        spreadCooldownSec: Number(spreadCooldownSec),
      },
      sinceSec,
    );
    if (decision.action === "none") return;
    const target = accounts.find((a) => a.slot === decision.to);
    if (!target) return;
    await switchTo(target, active.slot, decision.reason);
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
  const RATE_LIMIT_RE = /rate.?limit|usage.?limit|429|subscription.*(limit|window)|out of.*(quota|usage)/i;
  bb.events.on("thread.failed", ({ thread, error }) => {
    void (async () => {
      if (!error || !RATE_LIMIT_RE.test(error)) return;
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
      try {
        const status = await bb.sdk.threads.rateLimitRecovery({ threadId: thread.id });
        if (status.reason === "eligible" && status.candidate) {
          await new Promise((r) => setTimeout(r, 3000));
          await bb.sdk.threads.continueAfterRateLimit({
            threadId: thread.id,
            failedRequestId: status.candidate.failedRequestId,
          });
          bb.log.info(`thread ${thread.id} auto-continued on ${best.slot}`);
        } else {
          bb.log.info(`thread ${thread.id} not auto-continuable (${status.reason}) — switched account only`);
        }
      } catch (e) {
        bb.log.warn(`auto-continue failed for ${thread.id}: ${e instanceof Error ? e.message : e}`);
      }
    })();
  });

  bb.rpc.register(rpcContract, {
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
    ],
    async run(argv) {
      const cmd = argv[0] ?? "list";
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
