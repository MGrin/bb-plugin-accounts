/** Provider-scoped observations. Quota, paid credits and token counts never substitute for one another. */
import { z } from "zod";

export const MAX_AGE_SEC = 180;
export const providerAccountShape = z.object({
  providerId: z.enum(["claude-code", "codex"]),
  scope: z.enum(["account", "local-session", "thread"]),
  accountId: z.string().nullable(),
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
const bool = (v: unknown): boolean | null => typeof v === "boolean" ? v : null;
export const isFresh = (at: unknown, now: number, maxAge = MAX_AGE_SEC): boolean =>
  positive(at) !== null && Number.isFinite(now) && now >= (at as number) && now - (at as number) <= maxAge;
export const isClaudeProvider = (id: unknown): id is "claude-code" => id === "claude-code";

export function unknownCodex(reason = "No fresh Codex subscription observation"): ProviderAccount {
  return { providerId: "codex", scope: "local-session", accountId: null, threadId: null,
    label: "Codex local session (account identity unavailable)", source: "mx-spawn-availability", observedAt: null,
    fresh: false, capacity: "unknown", reason, planType: null,
    credits: { hasCredits: null, unlimited: null, balance: null }, windows: [] };
}

export function normalizeCodex(value: unknown, now: number): ProviderAccount {
  const out = unknownCodex();
  const v = object(value);
  if (v.version !== 1) return out;
  const accountId = word(v.codex_account_id);
  out.accountId = accountId;
  if (accountId) { out.scope = "account"; out.label = `Codex account ${accountId}`; }
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
    return { providerId: "claude-code", scope: "account", accountId, threadId: null, label,
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
