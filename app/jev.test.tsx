import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { unknownJev, JEV_WINDOWS, type JevSpend } from "../telemetry.ts";
import { JevCard } from "./jev.tsx";

const now = 1_800_000_000;
const ok: JevSpend = { ...unknownJev(""), state: "ok", reason: "estimate", generatedAt: now - 90, lastDecisionAt: now - 1946, usdPerMtok: 0.042,
  covers: "calls made through `mx jev` only -- compaction spend is NOT in these numbers",
  windows: JEV_WINDOWS.map((name, i) => ({ name, since: now - 86_400, calls: 413 + i, inputTokens: 745_708, usd: 0.03132, bySet: [] })) };
const render = (spend: JevSpend | null, failed = false) => renderToStaticMarkup(createElement(JevCard, { spend, failed, now }));

test("ok: three windows with calls, tokens and dollars, newest decision age, reading age, and both caveats", () => {
  const html = render(ok);
  for (const name of JEV_WINDOWS) assert.match(html, new RegExp(`>${name}<`));
  assert.match(html, /413 calls/); assert.match(html, /745,708 input tokens/); assert.match(html, /\$0\.0313/);
  assert.match(html, /newest decision 32m ago/); assert.match(html, /reading 90s old/);
  assert.match(html, /estimate, not a bill/i); assert.match(html, /0\.042/);
  assert.match(html, /compaction spend is NOT in these numbers/);
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
