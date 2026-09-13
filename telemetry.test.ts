import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCodex, normalizeClaude, normalizeCodexEvents, formatTelemetry, isClaudeProvider } from "./telemetry.ts";
const now = 1_800_000_000;
const window = (usedPercent = 6) => ({ usedPercent, resetsAt: now + 3000, windowDurationMins: 300 });
function snapshot() { return { version: 1, observed_at: now, codex: "available", codex_usage: {
  rateLimits: null, rateLimitsByLimitId: { codex: { limitId: "codex", planType: "plus", primary: window(), secondary: window(50),
    credits: { hasCredits: true, unlimited: false, balance: "12.34" } } } } }; }

test("Codex main quota, Spark, credits and account identity stay distinct", () => {
  const v = snapshot();
  Object.assign(v, { codex_account_id: "acct-123", codex_observed_at: now, observed_at: now - 9999 });
  Object.assign(v.codex_usage.rateLimitsByLimitId, { "codex-spark": { primary: window(100), secondary: null } });
  const a = normalizeCodex(v, now);
  assert.equal(a.capacity, "available"); assert.equal(a.accountId, "acct-123"); assert.equal(a.scope, "account");
  assert.equal(a.planType, "plus"); assert.equal(a.credits.balance, "12.34");
  assert.equal(a.windows.find(w => w.bucket === "codex-spark")?.usedPercent, 100);
  assert.equal(a.observedAt, now);
  v.codex = "exhausted"; v.codex_usage.rateLimitsByLimitId.codex.primary.usedPercent = 100;
  assert.equal(normalizeCodex(v, now).capacity, "exhausted");
});

test("unattributed Codex local-session snapshot does not invent an account", () => {
  const a = normalizeCodex(snapshot(), now);
  assert.equal(a.accountId, null); assert.equal(a.scope, "local-session");
});

const corruptions: [string, (v: any) => void][] = [
  ["version", v => v.version = 2], ["missing timestamp", v => delete v.observed_at],
  ["stale", v => v.observed_at = now - 181], ["future", v => v.observed_at = now + 1],
  ["string timestamp", v => v.observed_at = String(now)], ["missing main", v => delete v.codex_usage.rateLimitsByLimitId.codex],
  ["Spark only", v => v.codex_usage.rateLimitsByLimitId = { spark: v.codex_usage.rateLimitsByLimitId.codex }],
  ["missing secondary", v => delete v.codex_usage.rateLimitsByLimitId.codex.secondary],
  ["partial full window", v => { v.codex = "exhausted"; v.codex_usage.rateLimitsByLimitId.codex.primary.usedPercent = 100; delete v.codex_usage.rateLimitsByLimitId.codex.secondary; }],
  ["null windows", v => { v.codex_usage.rateLimitsByLimitId.codex.primary = null; v.codex_usage.rateLimitsByLimitId.codex.secondary = null; }],
  ["negative percent", v => v.codex_usage.rateLimitsByLimitId.codex.primary.usedPercent = -1],
  ["overflow percent", v => v.codex_usage.rateLimitsByLimitId.codex.primary.usedPercent = 101],
  ["null percent", v => v.codex_usage.rateLimitsByLimitId.codex.primary.usedPercent = null],
  ["string percent", v => v.codex_usage.rateLimitsByLimitId.codex.primary.usedPercent = "6"],
  ["reset elapsed", v => v.codex_usage.rateLimitsByLimitId.codex.primary.resetsAt = now],
  ["milliseconds reset", v => v.codex_usage.rateLimitsByLimitId.codex.primary.resetsAt = (now + 1000) * 1000],
  ["missing reset", v => delete v.codex_usage.rateLimitsByLimitId.codex.primary.resetsAt],
  ["different limit identity", v => v.codex_usage.rateLimitsByLimitId.codex.limitId = "spark"],
  ["unknown admission", v => v.codex = "unknown"], ["conflicting admission", v => v.codex = "exhausted"],
];
for (const [name, mutate] of corruptions) test(`${name} yields UNKNOWN`, () => {
  const v = snapshot(); mutate(v); assert.equal(normalizeCodex(v, now).capacity, "unknown");
});

test("an explicitly absent secondary is valid; main fallback requires its own codex ID", () => {
  const v: any = snapshot(); v.codex_usage.rateLimitsByLimitId.codex.secondary = null;
  v.codex_usage.rateLimits = v.codex_usage.rateLimitsByLimitId.codex;
  v.codex_usage.rateLimitsByLimitId = null;
  assert.equal(normalizeCodex(v, now).capacity, "available");
  delete v.codex_usage.rateLimits.limitId;
  assert.equal(normalizeCodex(v, now).capacity, "unknown");
});

test("reset passage never manufactures fresh quota", () => {
  assert.equal(normalizeCodex(snapshot(), now + 3001).capacity, "unknown");
});

test("malformed input and unrecognized fields do not leak into CLI output", () => {
  for (const v of [undefined, null, [], "wrong", {}, { version: 1 }]) assert.equal(normalizeCodex(v, now).capacity, "unknown");
  const v = snapshot(); Object.assign(v, { authToken: "DO-NOT-EMIT" });
  Object.assign(v.codex_usage.rateLimitsByLimitId.codex, { authToken: "DO-NOT-EMIT" });
  const a = normalizeCodex(v, now);
  assert.ok(!JSON.stringify(a).includes("DO-NOT-EMIT"));
  const cli = formatTelemetry({ version: 1, accounts: [a], tokens: [] });
  assert.match(cli, /subscription AVAILABLE/); assert.match(cli, /paid credits=on/);
});

const quota = (providerId = "codex", at = now * 1000) => ({ threadId: "t", createdAt: at, type: "provider/rateLimits/updated",
  data: { providerThreadId: "session-c", rateLimits: { providerId, status: "allowed", windows: [{ providerKey: "primary", status: "allowed", resetsAtMs: (now + 3000) * 1000 }] } } });
const token = () => ({ threadId: "t", createdAt: now * 1000, type: "thread/tokenUsage/updated", data: { providerThreadId: "session-c", tokenUsage: { total: {
  totalTokens: 800, inputTokens: 600, outputTokens: 200, cachedInputTokens: 100, reasoningOutputTokens: 50 } } } });

test("SDK quotas remain thread-scoped, with no invented percentages; token counts never imply quota", () => {
  const v = normalizeCodexEvents("t", [token(), quota()], now);
  assert.equal(v.account?.scope, "thread"); assert.equal(v.account?.accountId, null);
  assert.equal(v.account?.capacity, "unknown"); assert.equal(v.account?.windows[0].usedPercent, null);
  assert.equal(v.tokens?.totalTokens, 800); assert.equal(v.tokens?.providerId, "codex");
  assert.equal(normalizeCodexEvents("t", [token()], now).tokens, null);
  assert.equal(normalizeCodexEvents("t", [token(), quota("claude-code")], now).tokens, null);
  assert.equal(normalizeCodexEvents("t", [token(), quota(), quota("claude-code")], now).tokens, null);
  assert.equal(normalizeCodexEvents("other", [token(), quota()], now).account, null);
});

test("newest stale/malformed events do not resurrect older good data", () => {
  const bad = quota("codex", (now - 999) * 1000);
  assert.equal(normalizeCodexEvents("t", [bad, quota()], now).account?.fresh, false);
  const malformed: any = token(); malformed.data.tokenUsage.total.totalTokens = null;
  assert.equal(normalizeCodexEvents("t", [malformed, token(), quota()], now).tokens, null);
});

test("normalized Claude windows have the same subscription-only semantics", () => {
  const a = { slot: "a", email: "example", fiveHour: 100, sevenDay: 50, fiveHourResetsAt: new Date((now + 3000) * 1000).toISOString(), sevenDayResetsAt: new Date((now + 4000) * 1000).toISOString(), credits: "on" };
  assert.equal(normalizeClaude([a], now, now)[0].capacity, "exhausted");
  assert.equal(normalizeClaude([{ ...a, sevenDay: null }], now, now)[0].capacity, "unknown");
  assert.equal(normalizeClaude([a], now - 181, now)[0].capacity, "unknown");
});

test("only the exact Claude provider can use Claude switching", () => {
  for (const id of [undefined, null, "", "codex", "claude", "fake-claude", "provider-claude-code"]) assert.equal(isClaudeProvider(id), false);
  assert.equal(isClaudeProvider("claude-code"), true);
});
