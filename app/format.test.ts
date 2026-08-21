// node --test --experimental-strip-types app/format.test.ts
//
// The cases here are the ones that would make the page LIE. A null shown as
// 0% is the expensive one: it reads as a completely free account and is the
// exact inverse of what a null means.
import assert from "node:assert/strict";
import { test } from "node:test";
import { capacityNotice, clock, clockMs, creditLabel, formatPct, formatRelative, formatReset } from "./format.ts";

test("formatPct: an unpolled account is unknown, never 0%", () => {
  assert.equal(formatPct(null), "unknown");
  assert.equal(formatPct(undefined), "unknown");
  assert.equal(formatPct(Number.NaN), "unknown");
});

test("formatPct: a real zero is still a zero", () => {
  // 0 and null must not collapse into the same string — that collapse is the bug.
  assert.equal(formatPct(0), "0%");
  assert.notEqual(formatPct(0), formatPct(null));
});

test("formatPct: rounds and keeps the ceiling honest", () => {
  assert.equal(formatPct(33), "33%");
  assert.equal(formatPct(84.4), "84%");
  assert.equal(formatPct(99.6), "100%");
  assert.equal(formatPct(100), "100%");
});

test("formatRelative: minutes, hours, days", () => {
  assert.equal(formatRelative(9 * 60_000), "in 9m");
  assert.equal(formatRelative(59 * 60_000), "in 59m");
  assert.equal(formatRelative(4 * 3_600_000 + 20 * 60_000), "in 4h 20m");
  assert.equal(formatRelative(4 * 3_600_000), "in 4h");
  assert.equal(formatRelative(5 * 86_400_000 + 17 * 3_600_000), "in 5d 17h");
  assert.equal(formatRelative(2 * 86_400_000), "in 2d");
});

test("formatRelative: a reset already behind us says so instead of counting backwards", () => {
  assert.equal(formatRelative(0), "due now");
  assert.equal(formatRelative(-90_000), "due now");
  assert.equal(formatRelative(20_000), "in <1m");
});

test("formatReset: a missing or unparseable reset time stays missing", () => {
  const now = Date.parse("2026-08-18T10:59:00Z");
  assert.equal(formatReset(null, now), null);
  assert.equal(formatReset(undefined, now), null);
  assert.equal(formatReset("", now), null);
  assert.equal(formatReset("not a date", now), null);
});

test("formatReset: carries BOTH forms, and the relative one is the answer to 'now?'", () => {
  const now = Date.parse("2026-08-18T10:59:59.908Z");
  const r = formatReset("2026-08-18T15:19:59.908514+00:00", now);
  assert.ok(r);
  assert.equal(r.rel, "in 4h 20m");
  // The absolute half is locale/timezone dependent, so assert its shape, not
  // its literal text: a same-day reset is the short clock form.
  assert.match(r.at, /\d{1,2}[:.]\d{2}/);
});

test("formatReset: a reset on another day keeps the day in the absolute form", () => {
  const now = Date.parse("2026-08-18T10:59:59Z");
  const far = formatReset("2026-08-24T03:59:59+00:00", now);
  assert.ok(far);
  assert.match(far.rel, /^in 5d/);
  // Same instant rendered on its own day is shorter than rendered from a week out.
  const near = formatReset("2026-08-24T03:59:59+00:00", Date.parse("2026-08-24T00:00:00Z"));
  assert.ok(near);
  assert.ok(far.at.length > near.at.length, `${far.at} should carry more than ${near.at}`);
});

test("clockMs: last-switch.at is a MILLISECOND epoch and must not go through clock()", () => {
  // The real 2026-08-18T10:20:14Z switch. Fed to clock() as if it were
  // seconds it lands around the year 58620 — and clock() prints no year, so
  // the only symptom is a plausible-looking wrong month.
  const ms = Date.parse("2026-08-18T10:20:14.835Z");
  assert.notEqual(clockMs(ms), clock(ms));
  assert.equal(clockMs(ms), clock(Math.floor(ms / 1000)));
  assert.equal(clockMs(null), "—");
});

// ── The machine-level verdict, as the panel renders it (MX-220) ────────────
//
// The case these exist for is the PERSUASIVE one: credits on with every free
// window spent. It looks like an outage on every instrument that only counts
// windows, and it is not one — the machine serves, and it bills. A panel that
// renders that as "exhausted" tells mgrin to stop working when he can work,
// and a panel that renders it as plain "available" spends his money without
// saying so. Both failures are silent, which is why they are tested and not
// merely commented.

test("capacityNotice: paid-only is NOT an outage, and it says the work bills", () => {
  const n = capacityNotice("paid-only");
  assert.ok(n, "paid-only must produce a notice — silence here is the panel spending money quietly");
  assert.equal(n.tone, "warn");
  assert.match(n.text, /BILLS/);
  // The word that would make it read as an outage must not appear.
  assert.doesNotMatch(n.text, /walled|cannot serve/i);
});

test("capacityNotice: paid-only and none are different states, rendered differently", () => {
  const paid = capacityNotice("paid-only");
  const none = capacityNotice("none");
  assert.ok(paid && none);
  assert.notEqual(paid.tone, none.tone);
  assert.notEqual(paid.text, none.text);
});

test("capacityNotice: free says nothing at all", () => {
  assert.equal(capacityNotice("free"), null);
});

test("capacityNotice: unknown is CANNOT TELL — never either extreme", () => {
  const n = capacityNotice("unknown");
  assert.ok(n);
  assert.equal(n.tone, "unknown");
  assert.match(n.text, /cannot tell/i);
  // Not the outage wording and not the billing wording: a stale or unreadable
  // account asserts nothing about whether this machine can serve.
  assert.doesNotMatch(n.text, /BILLS/);
  assert.doesNotMatch(n.text, /every account is walled/i);
});

test("creditLabel: credits ON shows the amount", () => {
  assert.equal(
    creditLabel("on", { used: 74.62, limit: 100, util: 74.62, currency: "GBP" }),
    "credits 74.62/100.00 GBP",
  );
});

test("creditLabel: credits ON with no spend reading still says the path is open", () => {
  // The paid path exists whether or not the spend endpoint answered; reporting
  // nothing here would hide the only account that can still serve.
  assert.equal(creditLabel("on", null), "credits on");
  assert.equal(creditLabel("on", { used: null, limit: null, util: null, currency: null }), "credits on");
});

test("creditLabel: credits OFF shows nothing", () => {
  assert.equal(creditLabel("off", null), null);
});

test("creditLabel: an unpolled account is `credits ?`, never `off`", () => {
  // Same rule as formatPct: a failed poll knows nothing, and rendering that
  // silence as "off" is the silent downgrade to exhausted.
  assert.equal(creditLabel("unknown", null), "credits ?");
  assert.notEqual(creditLabel("unknown", null), creditLabel("off", null));
});
