/** Provider-scoped observations. Quota, paid credits and token counts never substitute for one another. */
import { z } from "zod";

export const MAX_AGE_SEC = 180;
export const providerAccountShape = z.object({
  providerId: z.enum(["claude-code", "codex"]),
  slot: z.string().nullable().optional(),
  active: z.boolean().optional(),
  scope: z.enum(["account", "local-session", "thread"]),
  accountId: z.string().nullable(),
  email: z.string().nullable(),
  threadId: z.string().nullable(),
  label: z.string(),
  source: z.enum(["claude-usage-cache", "mx-spawn-availability", "bb-sdk-event", "codex-slot-cache"]),
  observedAt: z.number().nullable(), // epoch seconds, never the time a cached result was read
  fresh: z.boolean(),
  capacity: z.enum(["available", "exhausted", "unavailable", "unknown"]), // subscription only
  // MX-1527: present only on a paused account (mgrin's act): NO request is made on it, so every
  // number here is the last-known one and capacity stays `unknown` — never a new enum value,
  // because the dotfiles widget feed validates it. Absent, never undefined, on the RPC wire.
  paused: z.object({ at: z.number() }).optional(),
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

/** One sentence for a paused account, shared by every provider so the surfaces read alike. */
export const pausedReason = (at: number): string =>
  at > 0 ? `Paused since ${new Date(at * 1000).toISOString()} — no requests made` : "Paused — no requests made";

/** The existing Claude reader supplies its sanitized account rows; attribution remains the cache's slot. */
export function normalizeClaude(accounts: readonly { slot: string; email: string; fiveHour: number | null; sevenDay: number | null;
  fiveHourResetsAt: string | null; sevenDayResetsAt: string | null; credits: string;
  paused?: { at: number }; lastRead?: { at: number; fiveHour: number | null; sevenDay: number | null } }[], observedAt: number | null, now: number): ProviderAccount[] {
  observedAt = epochSeconds(observedAt);
  return accounts.slice(0, 64).map(a => {
    const accountId = word(a.slot);
    const label = typeof a.email === "string" ? a.email.slice(0, 256) : "Claude account (identity unavailable)";
    if (a.paused) {
      // No request was made, so nothing here is a reading: the last read is shown as last-known
      // (its own time, never fresh) and capacity asserts nothing.
      const at = number(a.paused.at) ?? 0;
      const last = a.lastRead;
      return { providerId: "claude-code", scope: "account", accountId, email: emailAddress(a.email), threadId: null, label,
        source: "claude-usage-cache", observedAt: epochSeconds(last?.at), fresh: false, capacity: "unknown", paused: { at },
        reason: pausedReason(at), planType: null,
        windows: [["five-hour", last?.fiveHour, 300], ["seven-day", last?.sevenDay, 10080]].map(([key, used, durationMinutes]) => ({
          bucket: "claude", key: key as string, usedPercent: percent(used), resetsAt: null, durationMinutes: durationMinutes as number, reportedStatus: null })),
        credits: { hasCredits: null, unlimited: null, balance: null } };
    }
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
    return `${a.providerId} ${a.scope}${a.threadId ? ` ${a.threadId}` : ""} ${a.label}\n  ${a.paused ? "PAUSED" : `subscription ${a.capacity.toUpperCase()}`} · ${a.reason}\n  observed=${a.observedAt ?? "?"} fresh=${a.fresh} source=${a.source}${a.planType ? ` plan=${a.planType}` : ""}\n  ${windows || "windows UNKNOWN"}\n  paid credits=${a.credits.hasCredits === null ? "UNKNOWN" : a.credits.hasCredits ? "on" : "off"}${a.credits.balance === null ? "" : ` balance=${a.credits.balance}`} (separate from subscription)`;
  });
  for (const tkn of t.tokens) lines.push(`codex thread ${tkn.threadId}: ${tkn.totalTokens} tokens (not quota), observed=${tkn.observedAt} fresh=${tkn.fresh}`);
  return lines.join("\n\n");
}

/** Captured slots preserve identity even when a quota probe failed. */
export function normalizeCodexSlots(value: unknown, now: number): ProviderAccount[] {
  const root = object(value);
  if (root.version !== 1 || !Array.isArray(root.accounts) || root.accounts.length > 32 || !root.accounts.length)
    return [unknownCodex('Codex slots unavailable; capture and poll accounts')];
  const seenSlots = new Set<string>(), seenIds = new Set<string>();
  const rows: ProviderAccount[] = [];
  for (const raw of root.accounts) {
    const row = object(raw);
    const slot = typeof row.slot === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/.test(row.slot) ? row.slot : null;
    const id = word(row.accountId);
    if (!slot || !id || seenSlots.has(slot) || seenIds.has(id))
      return [unknownCodex('Codex slot manifest has invalid or duplicate identity')];
    seenSlots.add(slot); seenIds.add(id);
    const snap = object(row.snapshot), out = normalizeCodex(snap, now);
    const matches = out.accountId === id && row.observedAt === snap.codex_observed_at;
    if (!matches || row.error || row.reauthRequired === true) {
      Object.assign(out, unknownCodex('Codex slot identity or authentication unavailable'));
    }
    Object.assign(out, {slot, active: row.active === true, accountId: id, scope: 'account', source: 'codex-slot-cache'});
    out.label = out.email ?? emailAddress(row.label) ?? slot;
    const paused = object(row.paused);
    if (row.paused !== undefined && row.paused !== null && typeof row.paused === 'object') {
      // The cached snapshot is the PREVIOUS observation: keep its windows as last-known, but it
      // is neither fresh nor a capacity answer (MX-1527).
      const at = number(paused.at) ?? 0;
      Object.assign(out, {paused: {at}, fresh: false, capacity: 'unknown', reason: pausedReason(at)});
    }
    rows.push(out);
  }
  if (rows.filter(r=>r.active).length > 1) return [unknownCodex('Codex cache has multiple active identities')];
  return rows;
}

/** Main subscription only; unknown readings and paid balances cannot be selected. */
export function chooseCodexSlot(rows: readonly ProviderAccount[], activeSlot: string, switchAt = 97, now = Date.now()/1000): string | null {
  if (!Number.isFinite(switchAt) || switchAt < 1 || switchAt > 100) return null;
  const usable = (r: ProviderAccount) => !r.paused && r.providerId === 'codex' && r.scope === 'account' && r.slot && r.accountId &&
    r.fresh && isFresh(r.observedAt, now) && ['available','exhausted'].includes(r.capacity) &&
    r.windows.some(w=>w.bucket==='codex') && r.windows.filter(w=>w.bucket==='codex').every(w=>
      w.usedPercent !== null && w.usedPercent >= 0 && w.usedPercent <= 100 && w.resetsAt !== null && w.resetsAt > now);
  const active = rows.filter(r=>r.active);
  if (active.length !== 1 || active[0]!.slot !== activeSlot || !usable(active[0]!)) return null;
  const used = (r: ProviderAccount) => Math.max(...r.windows.filter(w=>w.bucket==='codex').map(w=>w.usedPercent!));
  if (active[0]!.capacity !== 'exhausted' && used(active[0]!) < switchAt) return null;
  return rows.filter(r=>r.slot !== activeSlot && usable(r) && r.capacity === 'available' && used(r) < used(active[0]!) && used(r)<switchAt)
    .sort((a,b)=>used(a)-used(b) || a.slot!.localeCompare(b.slot!))[0]?.slot ?? null;
}
