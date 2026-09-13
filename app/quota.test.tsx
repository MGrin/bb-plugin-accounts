import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { unknownCodex } from "../telemetry.ts";
import { Quota } from "./quota.tsx";

test("dashboard renders UNKNOWN without a quota percentage and labels credits separately", () => {
  const html = renderToStaticMarkup(createElement(Quota, { account: unknownCodex(), compact: false }));
  assert.match(html, /Subscription UNKNOWN/);
  assert.match(html, /Paid credits unknown/);
  assert.match(html, /account identity unavailable/);
  assert.ok(!html.includes("0%"));
});

test("dashboard keeps Spark visible separately and mutes stale quota meters", () => {
  const a = { ...unknownCodex(), observedAt: 1_800_000_000, windows: [
    { bucket: "codex", key: "primary", usedPercent: 6, resetsAt: 1_800_003_000, durationMinutes: 300, reportedStatus: null },
    { bucket: "spark", key: "primary", usedPercent: 100, resetsAt: 1_800_003_000, durationMinutes: 300, reportedStatus: null },
  ] };
  const html = renderToStaticMarkup(createElement(Quota, { account: a, compact: false }));
  assert.match(html, /codex/); assert.match(html, /spark/); assert.match(html, /stale/);
  assert.match(html, /Subscription UNKNOWN/);
  const compact = renderToStaticMarkup(createElement(Quota, { account: a, compact: true }));
  assert.ok(!compact.includes("spark"));
});
