// node --test --experimental-strip-types lib.test.ts
//
// The cases below are the ones that actually happened, or that would be
// expensive to discover at 3am: the real 2026-08-09 stranding, a switch into an
// equally-dead account, and thrash.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type AccountUsage, decideSwitch, pickBest, type SwitchPolicy, worst } from "./lib.ts";

const POLICY: SwitchPolicy = { switchAt: 97, spreadMargin: 25, cooldownSec: 120, spreadCooldownSec: 1800 };
const acct = (slot: string, fiveHour: number | null, sevenDay: number | null, active = false): AccountUsage =>
  ({ slot, active, fiveHour, sevenDay });

test("worst() is the sooner of the two walls, not the friendlier one", () => {
  assert.equal(worst(acct("a", 70, 83)), 83);
  assert.equal(worst(acct("a", 99, 5)), 99);
});

test("the 2026-08-09 stranding: switches off a spent WEEK toward a fresh account", () => {
  // Exactly what the poller saw and declined to act on: active fine on 5h, two
  // days from its weekly reset, while a slot with 85% of its week free idled.
  const d = decideSwitch(
    [
      acct("withflare", 70, 83, true),
      acct("mr6r1n", 0, 15),
      acct("scani", 100, 15),
    ],
    POLICY,
    3600,
  );
  if (d.action === "none") assert.fail(`expected a spread switch, got none: ${d.reason}`);
  assert.equal(d.action, "spread");
  assert.equal(d.to, "mr6r1n");
});

test("does not switch into an account whose own week is spent", () => {
  const d = decideSwitch([acct("a", 98, 10, true), acct("b", 0, 100)], POLICY, 3600);
  assert.equal(d.action, "none", "a 100% week trips again on the next poll");
});

test("urgent needs the destination to be genuinely better, not merely different", () => {
  const d = decideSwitch([acct("a", 98, 10, true), acct("b", 99, 20)], POLICY, 3600);
  assert.equal(d.action, "none");
  assert.match(d.reason, /no better/);
});

test("urgent overrides the spread cooldown, spread does not", () => {
  const hot = [acct("a", 99, 10, true), acct("b", 1, 5)];
  assert.equal(decideSwitch(hot, POLICY, 300).action, "urgent", "a stalled thread costs more than churn");

  const merelyWorse = [acct("a", 60, 80, true), acct("b", 1, 5)];
  const d = decideSwitch(merelyWorse, POLICY, 300);
  assert.equal(d.action, "none");
  assert.match(d.reason, /spread cooldown/);
});

test("the short cooldown blocks everything, including urgent", () => {
  const d = decideSwitch([acct("a", 99, 10, true), acct("b", 1, 5)], POLICY, 60);
  assert.equal(d.action, "none");
  assert.match(d.reason, /^cooldown/);
});

test("no churn when the alternative is only slightly roomier", () => {
  // The live 00:00 state: active 7%/16%, another slot 0%/15%. Gap of 1.
  const d = decideSwitch([acct("mr6r1n", 7, 16, true), acct("scani", 0, 15)], POLICY, 7200);
  assert.equal(d.action, "none");
  assert.match(d.reason, /gap 1 < margin 25/);
});

test("an unpolled account only LOOKS free and is never a destination", () => {
  assert.equal(pickBest([acct("a", 50, 50, true), acct("b", null, null)], "a"), null);
});

test("spreadMargin 0 disables early switching but leaves urgent alone", () => {
  const off = { ...POLICY, spreadMargin: 0 };
  assert.equal(decideSwitch([acct("a", 60, 80, true), acct("b", 1, 5)], off, 7200).action, "none");
  assert.equal(decideSwitch([acct("a", 99, 80, true), acct("b", 1, 5)], off, 7200).action, "urgent");
});

test("says why it did nothing — a silent no-op is indistinguishable from a broken switcher", () => {
  const reasons = [
    decideSwitch([], POLICY, 7200).reason,
    decideSwitch([acct("a", 50, 50, true)], POLICY, 7200).reason,
    decideSwitch([acct("a", 50, 50, true), acct("b", 49, 49)], POLICY, 7200).reason,
  ];
  for (const r of reasons) assert.ok(r.length > 0, "every decision must carry a reason");
});

test("ties break deterministically, so a tie cannot flap between two slots", () => {
  const accounts = [acct("a", 99, 10, true), acct("z", 5, 5), acct("b", 5, 5)];
  const first = decideSwitch(accounts, POLICY, 7200);
  const again = decideSwitch([...accounts].reverse(), POLICY, 7200);
  if (first.action === "none" || again.action === "none") assert.fail("expected a switch both ways round");
  assert.equal(first.to, "b");
  assert.equal(again.to, "b");
});
