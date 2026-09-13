import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { unknownCodex, type Telemetry } from "../telemetry.ts";
import { Quota, ThreadTelemetry } from "./quota.tsx";

const account = () => ({ ...unknownCodex(), accountId: "8b3beda7-0642-4ae4-a170-d6b403fb697d", email: "reader@example.com",
  label: "Codex account 8b3beda7-0642-4ae4-a170-d6b403fb697d", fresh: true, capacity: "available" as const,
  observedAt: 1_800_000_000, windows: [
    { bucket: "codex", key: "primary", usedPercent: 23, resetsAt: 1_800_003_000, durationMinutes: 10080, reportedStatus: null },
    { bucket: "spark", key: "primary", usedPercent: 100, resetsAt: 1_800_003_000, durationMinutes: 300, reportedStatus: null },
  ] });

test("default card shows email, main usage and reset; secondary quota/credits/debug are collapsed", () => {
  const a = account();
  const html = renderToStaticMarkup(createElement(Quota, { account: a }));
  const visible = html.split("<details")[0];
  assert.match(visible, /reader@example.com/); assert.match(visible, /23% used/);
  assert.match(visible, /Weekly/); assert.match(visible, /Resets /);
  for (const extra of ["spark", "Paid credits", "Observed", "mx-spawn", "Subscription available"]) assert.ok(!visible.includes(extra), extra);
  assert.match(html, /<summary[^>]*>Details<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]*\bopen[=\s>]/);
  assert.match(html, /spark/); assert.match(html, /Paid credits/); assert.match(html, /Observed/);
  assert.ok(!html.includes(a.accountId), "UUID must never be display text, even with an old label");
});

test("email missing never falls back to UUID; unknown usage has no fabricated 0%", () => {
  const a = { ...unknownCodex(), accountId: "private-uuid", label: "Codex account private-uuid" };
  const html = renderToStaticMarkup(createElement(Quota, { account: a }));
  assert.match(html, /email unavailable/); assert.match(html, /unavailable or stale/);
  assert.ok(!html.includes("private-uuid")); assert.ok(!html.includes("0%"));
});

test("stale main quota is muted while its reset remains visible", () => {
  const html = renderToStaticMarkup(createElement(Quota, { account: { ...account(), fresh: false } }));
  const visible = html.split("<details")[0];
  assert.match(visible, /stale/); assert.match(visible, /border-dashed/); assert.match(visible, /Resets /);
});

test("thread quota and tokens are inside the closed details, separate from main usage", () => {
  const data: Telemetry = { version: 1, accounts: [{ ...unknownCodex(), scope: "thread", threadId: "t" }], tokens: [{
    providerId: "codex", threadId: "t", observedAt: 1_800_000_000, fresh: true, totalTokens: 1234,
    inputTokens: 1000, outputTokens: 234, cachedInputTokens: 0, reasoningOutputTokens: 0,
  }] };
  const html = renderToStaticMarkup(createElement(Quota, { account: account() }, createElement(ThreadTelemetry, { data })));
  assert.ok(!html.split("<details")[0].includes("tokens"));
  assert.match(html.slice(html.indexOf("<details")), /1,234 tokens/);
  assert.match(html, /not subscription quota/);
});
