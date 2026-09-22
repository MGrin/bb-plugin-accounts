import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { unknownJev, JEV_WINDOWS, type JevSpend } from "../telemetry.ts";
import { JevCard } from "./jev.tsx";

const now = 1_800_000_000;
const ok: JevSpend = { ...unknownJev(""), state: "ok", reason: "counts", generatedAt: now - 90, lastDecisionAt: now - 1946, billing: null,
  covers: "calls made through `mx jev` only -- compaction spend is NOT in these numbers",
  windows: JEV_WINDOWS.map((name, i) => ({ name, since: now - 86_400, calls: 413 + i, inputTokens: 745_708, bySet: [] })) };
const billed: JevSpend = { ...ok, billing: { amountUsd: 12.5, recordedAt: now - 7200, period: "Sep 2026",
  source: "https://console.typesafe.ai/usage", asOf: null } };
const render = (spend: JevSpend | null, failed = false) => renderToStaticMarkup(createElement(JevCard, { spend, failed, now }));

test("ok: three windows of calls and tokens, ages, both caveats, and NO dollar figure without a console reading", () => {
  const html = render(ok);
  for (const name of JEV_WINDOWS) assert.match(html, new RegExp(`>${name}<`));
  assert.match(html, /413 calls/); assert.match(html, /745,708 input tokens/);
  assert.match(html, /newest decision 32m ago/); assert.match(html, /reading 90s old/);
  assert.match(html, /no console reading, so no dollar figure/); assert.doesNotMatch(html, /\$/);
  assert.match(html, /bills the account across every key/);
  assert.match(html, /compaction spend is NOT in these numbers/);
});

test("a console reading is the one dollar figure, with its period and age (control for every absence)", () => {
  const html = render(billed);
  assert.match(html, /Billed \$12\.50 · Sep 2026 · read 2h ago from the TypeSafe console/);
});

test("no data, unknown, a failed rpc and loading print no figure; control above shows ok does", () => {
  const cases: [string, string, RegExp][] = [
    ["no-data", render({ ...unknownJev(""), state: "no-data", reason: "the Jev decision log does not exist" }), /No data.*does not exist/],
    ["unknown", render(unknownJev("mx not found")), /UNKNOWN.*mx not found/],
    ["rpc failed", render(ok, true), /UNKNOWN.*could not be refreshed/],
    ["loading", render(null), /Loading/],
  ];
  for (const [name, html, says] of cases) {
    assert.match(html, says, name);
    assert.doesNotMatch(html, /\$/, name); assert.doesNotMatch(html, /\b0 calls/, name); assert.doesNotMatch(html, /\d calls/, name);
    assert.match(html, /mx jev/, `${name}: the covers caveat is always on screen`);
  }
});
