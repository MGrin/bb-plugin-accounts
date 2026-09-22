import test from "node:test";
import assert from "node:assert/strict";
import { normalizeJev, unknownJev, formatJev, JEV_COVERS } from "./telemetry.ts";

const now = 1_789_990_800;
// The version-2 shape `mx jev usage --json` prints (MX-1200), trimmed to one set: no dollar
// field in any window; the one dollar figure is `billing`, a recorded console reading.
const reading = () => ({
  version: 2, generated_at: now - 30, source: "/x/decisions.jsonl", log_present: true, last_decision_ts: now - 1946,
  covers: "calls made through `mx jev` only. The compaction plugin is NOT in these numbers",
  billing: null as unknown, billing_error: null,
  windows: [
    { name: "24h", since: now - 86_400, calls: 413, input_tokens: 745_708, by_set: [{ set: "done-scope", calls: 331, input_tokens: 366_205 }] },
    { name: "7d", since: now - 604_800, calls: 1117, input_tokens: 5_428_603, by_set: [] },
    { name: "30d", since: now - 2_592_000, calls: 1117, input_tokens: 5_428_603, by_set: [] },
  ],
});
const billing = { amount_usd: 12.5, recorded_ts: now - 7200, recorded_at: "2026-09-22T03:00:00Z", period: "Sep 2026",
  source: "https://console.typesafe.ai/usage", as_of: "Sep 22, 03:00", keys: null };

test("a good reading is ok, with three windows of counts and mx's own covers sentence", () => {
  const j = normalizeJev(reading(), now);
  assert.equal(j.state, "ok");
  assert.deepEqual(j.windows.map(w => [w.name, w.calls, w.inputTokens]),
    [["24h", 413, 745_708], ["7d", 1117, 5_428_603], ["30d", 1117, 5_428_603]]);
  assert.equal(j.lastDecisionAt, now - 1946); assert.equal(j.generatedAt, now - 30);
  assert.equal(j.billing, null, "no console reading, no dollars (MX-1200)");
  assert.match(j.covers, /compaction plugin is NOT/);
  assert.deepEqual(j.windows[0].bySet, [{ set: "done-scope", calls: 331, inputTokens: 366_205 }]);
});

test("only a well-formed console reading carries dollars; a malformed one is dropped, never shown", () => {
  const j = normalizeJev({ ...reading(), billing }, now);
  assert.deepEqual(j.billing, { amountUsd: 12.5, recordedAt: now - 7200, period: "Sep 2026",
    source: "https://console.typesafe.ai/usage", asOf: "Sep 22, 03:00" });
  for (const bad of [{ ...billing, amount_usd: -1 }, { ...billing, amount_usd: "12" }, { ...billing, recorded_ts: null },
    { ...billing, period: 7 }, "x", 3, [billing]]) {
    const k = normalizeJev({ ...reading(), billing: bad }, now);
    assert.equal(k.state, "ok", JSON.stringify(bad)); assert.equal(k.billing, null, JSON.stringify(bad));
  }
});

test("no log, or no decision in it, is NO DATA: not zero spend, and no window survives", () => {
  for (const change of [{ log_present: false }, { last_decision_ts: null }]) {
    const j = normalizeJev({ ...reading(), ...change }, now);
    assert.equal(j.state, "no-data", JSON.stringify(change));
    assert.deepEqual(j.windows, []);
  }
});

test("every refused reading is UNKNOWN with a reason naming what was wrong, and carries no figure", () => {
  const bad: [string, unknown, RegExp][] = [
    ["not an object", "garbage", /not a JSON object/],
    ["version 1", { ...reading(), version: 1 }, /version/],
    ["version missing", { ...reading(), version: undefined }, /version/],
    ["two windows", { ...reading(), windows: reading().windows.slice(0, 2) }, /window/],
    ["renamed window", { ...reading(), windows: [{ ...reading().windows[0], name: "1d" }, ...reading().windows.slice(1)] }, /window/],
    ["NaN-ish calls", { ...reading(), windows: [{ ...reading().windows[0], calls: "413" }, ...reading().windows.slice(1)] }, /window/],
    ["null tokens", { ...reading(), windows: [{ ...reading().windows[0], input_tokens: null }, ...reading().windows.slice(1)] }, /window/],
    ["log_present not bool", { ...reading(), log_present: "yes" }, /log_present/],
  ];
  for (const [name, value, reason] of bad) {
    const j = normalizeJev(value, now);
    assert.equal(j.state, "unknown", name); assert.match(j.reason, reason, name);
    assert.deepEqual(j.windows, [], name); assert.equal(j.billing, null, name);
  }
});

test("the covers caveat survives every state, falling back to a plain sentence of our own", () => {
  assert.match(unknownJev("x").covers, /mx jev.*only/);
  assert.match(unknownJev("x").covers, /fast-jev-compaction/);
  assert.equal(normalizeJev({ ...reading(), covers: 7 }, now).covers, JEV_COVERS);
});

test("the text form prints a dollar figure ONLY from a console reading (control: a reading does)", () => {
  const billed = formatJev(normalizeJev({ ...reading(), billing }, now), now);
  assert.match(billed, /\$12\.50 for Sep 2026/); assert.match(billed, /TypeSafe console/); assert.match(billed, /read 2h ago/);
  const ok = formatJev(normalizeJev(reading(), now), now);
  assert.doesNotMatch(ok, /\$/); assert.match(ok, /no dollar figure/); assert.match(ok, /745,708 input tokens/); assert.match(ok, /covers/);
  for (const j of [unknownJev("mx not found"), normalizeJev({ ...reading(), log_present: false }, now)]) {
    const text = formatJev(j, now);
    assert.doesNotMatch(text, /\$/); assert.doesNotMatch(text, /\b0 calls/); assert.match(text, /covers/);
  }
  assert.match(formatJev(unknownJev("mx not found"), now), /UNKNOWN.*mx not found/);
  assert.match(formatJev(normalizeJev({ ...reading(), log_present: false }, now), now), /NO DATA/);
});
