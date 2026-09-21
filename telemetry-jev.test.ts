import test from "node:test";
import assert from "node:assert/strict";
import { normalizeJev, unknownJev, formatJev, JEV_COVERS } from "./telemetry.ts";

const now = 1_789_990_800;
// The shape `mx jev usage --json` printed on this machine, 2026-09-21, trimmed to one set.
const reading = () => ({
  version: 1, generated_at: now - 30, source: "/x/decisions.jsonl", log_present: true, last_decision_ts: now - 1946,
  estimate: true, usd_per_mtok: 0.042, covers: "calls made through `mx jev` only. The compaction plugin is NOT in these numbers",
  windows: [
    { name: "24h", since: now - 86_400, calls: 413, input_tokens: 745_708, usd: 0.03132, by_set: [{ set: "done-scope", calls: 331, input_tokens: 366_205, usd: 0.015381 }] },
    { name: "7d", since: now - 604_800, calls: 1117, input_tokens: 5_428_603, usd: 0.228001, by_set: [] },
    { name: "30d", since: now - 2_592_000, calls: 1117, input_tokens: 5_428_603, usd: 0.228001, by_set: [] },
  ],
});

test("a good reading is ok, with three windows, the price and mx's own covers sentence", () => {
  const j = normalizeJev(reading(), now);
  assert.equal(j.state, "ok");
  assert.deepEqual(j.windows.map(w => [w.name, w.calls, w.inputTokens, w.usd]),
    [["24h", 413, 745_708, 0.03132], ["7d", 1117, 5_428_603, 0.228001], ["30d", 1117, 5_428_603, 0.228001]]);
  assert.equal(j.lastDecisionAt, now - 1946); assert.equal(j.generatedAt, now - 30); assert.equal(j.usdPerMtok, 0.042);
  assert.match(j.covers, /compaction plugin is NOT/);
  assert.deepEqual(j.windows[0].bySet, [{ set: "done-scope", calls: 331, inputTokens: 366_205, usd: 0.015381 }]);
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
    ["version 2", { ...reading(), version: 2 }, /version/],
    ["estimate false", { ...reading(), estimate: false }, /estimate/],
    ["estimate missing", { ...reading(), estimate: undefined }, /estimate/],
    ["two windows", { ...reading(), windows: reading().windows.slice(0, 2) }, /window/],
    ["renamed window", { ...reading(), windows: [{ ...reading().windows[0], name: "1d" }, ...reading().windows.slice(1)] }, /window/],
    ["negative usd", { ...reading(), windows: [{ ...reading().windows[0], usd: -1 }, ...reading().windows.slice(1)] }, /window/],
    ["NaN-ish calls", { ...reading(), windows: [{ ...reading().windows[0], calls: "413" }, ...reading().windows.slice(1)] }, /window/],
    ["null tokens", { ...reading(), windows: [{ ...reading().windows[0], input_tokens: null }, ...reading().windows.slice(1)] }, /window/],
    ["log_present not bool", { ...reading(), log_present: "yes" }, /log_present/],
  ];
  for (const [name, value, reason] of bad) {
    const j = normalizeJev(value, now);
    assert.equal(j.state, "unknown", name); assert.match(j.reason, reason, name);
    assert.deepEqual(j.windows, [], name);
  }
});

test("the covers caveat survives every state, falling back to a plain sentence of our own", () => {
  assert.match(unknownJev("x").covers, /mx jev.*only/);
  assert.match(unknownJev("x").covers, /fast-jev-compaction/);
  assert.equal(normalizeJev({ ...reading(), covers: 7 }, now).covers, JEV_COVERS);
});

test("the text form says ESTIMATE and covers, and prints no dollar figure unless ok (control: ok does)", () => {
  const ok = formatJev(normalizeJev(reading(), now), now);
  assert.match(ok, /\$0\.03132/); assert.match(ok, /estimate/i); assert.match(ok, /covers/);
  for (const j of [unknownJev("mx not found"), normalizeJev({ ...reading(), log_present: false }, now)]) {
    const text = formatJev(j, now);
    assert.doesNotMatch(text, /\$/); assert.doesNotMatch(text, /\b0 calls/); assert.match(text, /covers/);
  }
  assert.match(formatJev(unknownJev("mx not found"), now), /UNKNOWN.*mx not found/);
  assert.match(formatJev(normalizeJev({ ...reading(), log_present: false }, now), now), /NO DATA/);
});
