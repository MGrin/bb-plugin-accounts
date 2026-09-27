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

test("ok: recorded windows and estimates have explicit scope while account billing is absent", () => {
  const html = render(ok);
  for (const name of JEV_WINDOWS) assert.match(html, new RegExp(`>${name}<`));
  assert.match(html, /413 calls/); assert.match(html, /745,708 input tokens/);
  assert.match(html, /newest decision 32m ago/); assert.match(html, /reading 90s old/);
  assert.match(html, /Account billing: no console reading/); assert.match(html, /Local cost estimate/);
  assert.match(html, /Partial coverage/);
  assert.match(html, /compaction spend is NOT in these numbers/);
});

test("legacy console estimate retains its period and age without pretending it is account billing", () => {
  const html = render(billed);
  assert.match(html, /Last console estimate \$12\.50 · Sep 2026/); assert.match(html,/read 2h ago/);
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
    if(name !== "loading") assert.match(html, /mx jev/, `${name}: the covers caveat is always on screen`);
  }
});

test('Cloudflare keeps last account billing visible and explicitly stale even with no decisions', () => {
  const html=render({...billed,state:'no-data',billingRefresh:{state:'blocked',attemptedAt:now,rayId:null},billing:{...billed.billing!,kind:'account-billing',balanceUsd:2}});
  assert.match(html,/Cloudflare/); assert.match(html,/Last account spend/); assert.match(html,/\$12\.50/);
  assert.match(html,/\$2\.00/); assert.match(html,/stale/i); assert.doesNotMatch(html,/session expired/i);
});

test('local estimated cost stays distinct from account billing and unavailable coverage', () => {
  const html=render(ok);
  assert.match(html,/Local cost estimate/); assert.match(html,/\$0\.0313/);
  assert.match(html,/recorded.*only/i); assert.match(html,/Compaction.*unavailable/);
  assert.doesNotMatch(html,/Billed \$0\.0313/);
});

test('an RPC failure keeps previous billing with warning but hides old local estimates', () => {
  const html=render(billed,true);
  assert.match(html,/\$12\.50/); assert.match(html,/could not be refreshed/);
  assert.match(html,/stale/i); assert.doesNotMatch(html,/\$0\.0313/);
});
