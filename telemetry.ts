/** Provider-scoped observations. Quota, paid credits and token counts never substitute for one another. */
import { z } from "zod";

export const MAX_AGE_SEC = 180;
export const providerAccountShape = z.object({
  providerId: z.enum(["claude-code", "codex"]),
  scope: z.enum(["account", "local-session", "thread"]),
  accountId: z.string().nullable(),
  email: z.string().nullable(),
  threadId: z.string().nullable(),
  label: z.string(),
  source: z.enum(["claude-usage-cache", "mx-spawn-availability", "bb-sdk-event"]),
  observedAt: z.number().nullable(), // epoch seconds, never the time a cached result was read
  fresh: z.boolean(),
  capacity: z.enum(["available", "exhausted", "unavailable", "unknown"]), // subscription only
  reason: z.string(),
  planType: z.string().nullable(),
  credits: z.object({ hasCredits: z.boolean().nullable(), unlimited: z.boolean().nullable(), balance: z.string().nullable() }),
  windows: z.array(z.object({
    bucket: z.string(), key: z.string(), usedPercent: z.number().nullable(),
    resetsAt: z.number().nullable(), durationMinutes: z.number().nullable(),
    reportedStatus: z.string().nullable(),
  })),
});
export type ProviderAccount = z.infer<typeof providerAccountShape>;
export const tokenObservationShape = z.object({
  providerId: z.literal("codex"), threadId: z.string(), observedAt: z.number(), fresh: z.boolean(),
  totalTokens: z.number(), inputTokens: z.number(), outputTokens: z.number(),
  cachedInputTokens: z.number(), reasoningOutputTokens: z.number(),
});
export type TokenObservation = z.infer<typeof tokenObservationShape>;
export const telemetryShape = z.object({
  version: z.literal(1), accounts: z.array(providerAccountShape), tokens: z.array(tokenObservationShape),
});
export type Telemetry = z.infer<typeof telemetryShape>;
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const number = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
const percent = (v: unknown): number | null => number(v) !== null && (v as number) >= 0 && (v as number) <= 100 ? v as number : null;
const positive = (v: unknown): number | null => number(v) !== null && (v as number) > 0 ? v as number : null;
const epochSeconds = (v: unknown): number | null => positive(v) !== null && Number.isSafeInteger(v) && (v as number) <= 253402300799 ? v as number : null;
const word = (v: unknown): string | null => typeof v === "string" && v.length <= 100 && /^[\w .:+-]+$/.test(v) ? v : null;
const emailAddress = (v: unknown): string | null => {
  const parsed = z.string().trim().max(254).email().safeParse(v);
  return parsed.success ? parsed.data : null;
};
const bool = (v: unknown): boolean | null => typeof v === "boolean" ? v : null;
export const isFresh = (at: unknown, now: number, maxAge = MAX_AGE_SEC): boolean =>
  positive(at) !== null && Number.isFinite(now) && now >= (at as number) && now - (at as number) <= maxAge;
export const isClaudeProvider = (id: unknown): id is "claude-code" => id === "claude-code";

export function unknownCodex(reason = "No fresh Codex subscription observation"): ProviderAccount {
  return { providerId: "codex", scope: "local-session", accountId: null, email: null, threadId: null,
    label: "Codex account (email unavailable)", source: "mx-spawn-availability", observedAt: null,
    fresh: false, capacity: "unknown", reason, planType: null,
    credits: { hasCredits: null, unlimited: null, balance: null }, windows: [] };
}

export function normalizeCodex(value: unknown, now: number): ProviderAccount {
  const out = unknownCodex();
  const v = object(value);
  if (v.version !== 1) return out;
  const accountId = word(v.codex_account_id);
  out.accountId = accountId;
  if (accountId) out.scope = "account";
  out.email = emailAddress(v.codex_account_email);
  out.label = out.email ?? "Codex account (email unavailable)";
  out.observedAt = epochSeconds(Object.hasOwn(v, "codex_observed_at") ? v.codex_observed_at : v.observed_at);
  out.fresh = isFresh(out.observedAt, now);
  const usage = object(v.codex_usage);
  const buckets = object(usage.rateLimitsByLimitId);
  const fallback = object(usage.rateLimits);
  // A present malformed main bucket must not fall through to a different observation.
  const main = object(Object.hasOwn(buckets, "codex") ? buckets.codex : fallback.limitId === "codex" ? fallback : null);
  out.planType = word(main.planType);
  const credits = object(main.credits);
  out.credits = { hasCredits: bool(credits.hasCredits), unlimited: bool(credits.unlimited),
    balance: typeof credits.balance === "string" && /^\d+(\.\d+)?$/.test(credits.balance) ? credits.balance.slice(0, 40) : null };
  const entries = Object.entries(buckets).slice(0, 16);
  if (!Object.hasOwn(buckets, "codex") && Object.keys(main).length) entries.unshift(["codex", main]);
  let valid = Object.keys(main).length > 0 && (main.limitId === undefined || main.limitId === "codex");
  let mainCount = 0;
  let exhausted = main.spendControlReached === true;
  for (const [bucket, raw] of entries) {
    if (!word(bucket)) continue;
    const b = object(raw);
    for (const key of ["primary", "secondary"]) {
      const w = b[key];
      if (w === null) continue; // explicit absence is a legitimate plan shape
      const win = object(w);
      const usedPercent = percent(win.usedPercent);
      const resetsAt = epochSeconds(win.resetsAt);
      const usable = usedPercent !== null && resetsAt !== null && resetsAt > now;
      if (bucket === "codex") {
        valid &&= usable;
        mainCount += usable ? 1 : 0;
        exhausted ||= usedPercent === 100;
      }
      out.windows.push({ bucket, key, usedPercent, resetsAt,
        durationMinutes: positive(win.windowDurationMins), reportedStatus: null });
    }
  }
  if (!out.fresh) out.reason = "Codex observation missing, stale or future-dated";
  else if (!valid || !mainCount) out.reason = "Main Codex quota missing, partial, malformed or awaiting a fresh reset observation";
  else if (v.codex !== "available" && v.codex !== "exhausted") out.reason = "Availability probe could not establish ordinary Codex capacity";
  else {
    const capacity = exhausted ? "exhausted" : "available";
    if (capacity !== v.codex) out.reason = "Availability verdict and main quota disagree";
    else { out.capacity = capacity; out.reason = exhausted ? "Main Codex subscription exhausted" : "Main Codex subscription has headroom"; }
  }
  return out;
}

/** The existing Claude reader supplies its sanitized account rows; attribution remains the cache's slot. */
export function normalizeClaude(accounts: readonly { slot: string; email: string; fiveHour: number | null; sevenDay: number | null;
  fiveHourResetsAt: string | null; sevenDayResetsAt: string | null; credits: string }[], observedAt: number | null, now: number): ProviderAccount[] {
  observedAt = epochSeconds(observedAt);
  return accounts.slice(0, 64).map(a => {
    const accountId = word(a.slot);
    const label = typeof a.email === "string" ? a.email.slice(0, 256) : "Claude account (identity unavailable)";
    const fresh = isFresh(observedAt, now);
    const windows = [["five-hour", a.fiveHour, a.fiveHourResetsAt, 300], ["seven-day", a.sevenDay, a.sevenDayResetsAt, 10080]] as const;
    const normalized = windows.map(([key, used, reset, durationMinutes]) => ({ bucket: "claude", key, usedPercent: percent(used),
      resetsAt: reset && Number.isFinite(Date.parse(reset)) ? Date.parse(reset) / 1000 : null, durationMinutes, reportedStatus: null }));
    const valid = accountId !== null && fresh && normalized.every(w => w.usedPercent !== null && w.resetsAt !== null && w.resetsAt > now);
    const capacity = !valid ? "unknown" : normalized.some(w => w.usedPercent === 100) ? "exhausted" : "available";
    return { providerId: "claude-code", scope: "account", accountId, email: emailAddress(a.email), threadId: null, label,
      source: "claude-usage-cache", observedAt, fresh, capacity, reason: valid ? "Claude subscription windows" : "Claude windows missing, invalid or stale",
      planType: null, windows: normalized, credits: { hasCredits: a.credits === "on" ? true : a.credits === "off" ? false : null, unlimited: null, balance: null } };
  });
}

/** SDK quota events lack account identity and percentages/bucket completeness. Keep them thread-scoped. */
export function normalizeCodexEvents(threadId: string, rows: readonly unknown[], now: number): { account: ProviderAccount | null; tokens: TokenObservation | null } {
  let account: ProviderAccount | null = null;
  let tokens: TokenObservation | null = null;
  let sawQuota = false, sawTokens = false;
  for (const raw of rows.slice(0, 100)) { // descending SDK order; latest malformed observation invalidates older evidence
    const row = object(raw), data = object(row.data), rate = object(data.rateLimits);
    if (row.threadId !== threadId) continue;
    const at = positive(row.createdAt);
    if (row.type === "provider/rateLimits/updated" && rate.providerId === "codex" && !sawQuota) {
      sawQuota = true;
      account = { ...unknownCodex("SDK event has no account attribution or complete main-bucket quota"),
        scope: "thread", threadId, label: "Codex thread observation", source: "bb-sdk-event",
        observedAt: at === null ? null : epochSeconds(Math.floor(at / 1000)), fresh: isFresh(at === null ? null : at / 1000, now) };
      if (Array.isArray(rate.windows)) account.windows = rate.windows.slice(0, 16).map((w, i) => {
        const win = object(w);
        return { bucket: "unspecified", key: word(win.providerKey) ?? `window-${i + 1}`, usedPercent: null,
          resetsAt: positive(win.resetsAtMs) === null ? null : epochSeconds(Math.floor((win.resetsAtMs as number) / 1000)),
          durationMinutes: null, reportedStatus: ["allowed", "blocked", "warning", "unknown"].includes(String(win.status)) ? String(win.status) : null };
      });
    }
    // Tokens have no provider ID. Match their provider session to an explicit quota
    // event in this bounded page; the current thread provider alone cannot prove attribution.
    const session = data.providerThreadId;
    const providers = new Set(rows.slice(0, 100).flatMap(raw => {
      const r = object(raw), d = object(r.data), q = object(d.rateLimits);
      return r.threadId === threadId && r.type === "provider/rateLimits/updated" &&
        typeof session === "string" && session.length > 0 && d.providerThreadId === session ? [q.providerId] : [];
    }));
    if (row.type === "thread/tokenUsage/updated" && providers.size === 1 && providers.has("codex") && !sawTokens) {
      sawTokens = true;
      const total = object(object(data.tokenUsage).total);
      const keys = ["totalTokens", "inputTokens", "outputTokens", "cachedInputTokens", "reasoningOutputTokens"] as const;
      if (at !== null && keys.every(k => number(total[k]) !== null && Number.isSafeInteger(total[k]) && (total[k] as number) >= 0)) {
        tokens = { providerId: "codex", threadId, observedAt: at / 1000, fresh: isFresh(at / 1000, now),
          totalTokens: total.totalTokens as number, inputTokens: total.inputTokens as number, outputTokens: total.outputTokens as number,
          cachedInputTokens: total.cachedInputTokens as number, reasoningOutputTokens: total.reasoningOutputTokens as number };
      }
    }
  }
  return { account, tokens };
}

export function formatTelemetry(t: Telemetry): string {
  const lines = t.accounts.map(a => {
    const windows = a.windows.map(w => `${w.bucket}/${w.key} ${w.usedPercent === null ? "?" : `${w.usedPercent}%`} reset=${w.resetsAt === null ? "?" : new Date(w.resetsAt * 1000).toISOString()}`).join("; ");
    return `${a.providerId} ${a.scope}${a.threadId ? ` ${a.threadId}` : ""} ${a.label}\n  subscription ${a.capacity.toUpperCase()} · ${a.reason}\n  observed=${a.observedAt ?? "?"} fresh=${a.fresh} source=${a.source}${a.planType ? ` plan=${a.planType}` : ""}\n  ${windows || "windows UNKNOWN"}\n  paid credits=${a.credits.hasCredits === null ? "UNKNOWN" : a.credits.hasCredits ? "on" : "off"}${a.credits.balance === null ? "" : ` balance=${a.credits.balance}`} (separate from subscription)`;
  });
  for (const tkn of t.tokens) lines.push(`codex thread ${tkn.threadId}: ${tkn.totalTokens} tokens (not quota), observed=${tkn.observedAt} fresh=${tkn.fresh}`);
  return lines.join("\n\n");
}

/**
 * Jev spend, read from `mx jev usage --json` (MX-1172) and never recomputed here: mx and the
 * Übersicht widget read the same log through the same code, so a second reader would be a
 * second number. Three states and no fourth. `no-data` (no log, or no decision in it) is NOT
 * zero spend, and `unknown` is anything we could not trust; neither carries a figure.
 */
export const JEV_COVERS = "calls made through `mx jev` only. The fast-jev-compaction plugin and any script that posts to TypeSafe directly are NOT in these numbers";
const jevCountsShape = z.object({ calls: z.number(), inputTokens: z.number(), usd: z.number() });
export const jevSpendShape = z.object({
  state: z.enum(["ok", "no-data", "unknown"]),
  reason: z.string(),
  generatedAt: z.number().nullable(), // when mx took the reading, epoch seconds
  lastDecisionAt: z.number().nullable(),
  usdPerMtok: z.number().nullable(),
  covers: z.string(),
  windows: z.array(jevCountsShape.extend({ name: z.string(), since: z.number(), bySet: z.array(jevCountsShape.extend({ set: z.string() })) })),
});
export type JevSpend = z.infer<typeof jevSpendShape>;
export const JEV_WINDOWS = ["24h", "7d", "30d"] as const;

export function unknownJev(reason: string): JevSpend {
  return { state: "unknown", reason, generatedAt: null, lastDecisionAt: null, usdPerMtok: null, covers: JEV_COVERS, windows: [] };
}

const nonNegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const jevCounts = (v: Record<string, unknown>) =>
  nonNegative(v.calls) && nonNegative(v.input_tokens) && nonNegative(v.usd) ? { calls: v.calls, inputTokens: v.input_tokens, usd: v.usd } : null;

export function normalizeJev(value: unknown, _now: number): JevSpend {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return unknownJev("mx jev usage printed something that is not a JSON object");
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return unknownJev(`mx jev usage reported version ${JSON.stringify(v.version) ?? "none"}, this page reads version 1`);
  if (v.estimate !== true) return unknownJev("mx jev usage did not mark its figures as an estimate");
  if (typeof v.log_present !== "boolean") return unknownJev("mx jev usage gave no boolean log_present");
  const out: JevSpend = { ...unknownJev(""), generatedAt: epochSeconds(v.generated_at), usdPerMtok: nonNegative(v.usd_per_mtok) ? v.usd_per_mtok : null,
    covers: typeof v.covers === "string" && v.covers.length > 0 && v.covers.length <= 600 ? v.covers : JEV_COVERS };
  if (!v.log_present) return { ...out, state: "no-data", reason: "the Jev decision log does not exist" };
  if (v.last_decision_ts === null) return { ...out, state: "no-data", reason: "the Jev decision log holds no readable decision" };
  const lastDecisionAt = epochSeconds(v.last_decision_ts);
  if (lastDecisionAt === null) return { ...out, reason: "mx jev usage gave an unreadable last_decision_ts" };
  const rows = Array.isArray(v.windows) ? v.windows.map(object) : [];
  const windows: JevSpend["windows"] = [];
  for (const [i, name] of JEV_WINDOWS.entries()) {
    const row = rows[i], counts = row && jevCounts(row), since = row && epochSeconds(row.since);
    if (rows.length !== JEV_WINDOWS.length || !row || row.name !== name || !counts || since === null)
      return { ...out, reason: `mx jev usage window ${name} is missing or not non-negative finite numbers` };
    const bySet = (Array.isArray(row.by_set) ? row.by_set : []).slice(0, 32).map(object).flatMap(s => {
      const c = jevCounts(s), set = word(s.set);
      return c && set ? [{ set, ...c }] : [];
    });
    windows.push({ name, since: since as number, ...counts, bySet });
  }
  return { ...out, state: "ok", reason: "estimate from mx jev usage", lastDecisionAt, windows };
}

/** "3m", "5h", "2d" — the same buckets mx prints, so the page and the CLI read alike. */
export function jevAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return s < 120 ? `${s}s` : s < 7200 ? `${Math.floor(s / 60)}m` : s < 172_800 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`;
}

export function formatJev(j: JevSpend, now: number): string {
  const head = j.state === "unknown" ? `Jev spend UNKNOWN · ${j.reason}` : j.state === "no-data" ? `Jev spend NO DATA · ${j.reason}` :
    `Jev spend (an ESTIMATE: input tokens × $${j.usdPerMtok ?? "?"}/MTok, not a bill) · newest decision ${jevAge(now - (j.lastDecisionAt ?? now))} ago` +
    ` · reading ${j.generatedAt === null ? "age unknown" : `${jevAge(now - j.generatedAt)} old`}`;
  const rows = j.state !== "ok" ? [] : j.windows.map(w => `  ${w.name.padEnd(4)} ${w.calls.toLocaleString("en-US")} calls · ${w.inputTokens.toLocaleString("en-US")} input tokens · $${w.usd}`);
  return [head, ...rows, `  covers: ${j.covers}`].join("\n");
}
