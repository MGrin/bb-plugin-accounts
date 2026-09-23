// The adapters and the one card (MX-1226). What is asserted here is what mgrin said was
// missing from the homepage: reset times, state, and the same shape for both providers.
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { unknownCodex } from "../telemetry.ts";
import { AccountCard } from "./account-card.tsx";
import { claudeCards, codexCards } from "./cards.ts";
import type { Status } from "./current.tsx";

const NOW = Date.parse("2026-09-23T04:00:00Z");

const claudeStatus = (over: Partial<Status["accounts"][number]> = {}, stale = false): Status => ({
  polledAt: Math.floor(NOW / 1000),
  stale,
  capacity: "free",
  lastSwitch: null,
  accounts: [{
    slot: "one", email: "a@example.com", active: true,
    fiveHour: 35, sevenDay: 83,
    fiveHourResetsAt: "2026-09-23T04:59:59Z", sevenDayResetsAt: "2026-09-28T03:59:59Z",
    credits: "off", creditSpend: null, ...over,
  }],
});

const codexAccount = (over: Record<string, unknown> = {}) => ({
  ...unknownCodex(), email: "a@example.com", fresh: true, capacity: "available" as const,
  observedAt: Math.floor(NOW / 1000),
  windows: [{ bucket: "codex", key: "primary", usedPercent: 33, resetsAt: Math.floor(NOW / 1000) + 400_000, durationMinutes: 10080, reportedStatus: null }],
  ...over,
});

test("a Claude account carries its windows, both reset times and an ok state", () => {
  const [card] = claudeCards(claudeStatus(), NOW);
  assert.equal(card.provider, "Claude");
  assert.equal(card.label, "a@example.com");
  assert.equal(card.active, true);
  assert.equal(card.state, "ok");
  assert.deepEqual(card.windows.map(w => w.label), ["5h", "7d"]);
  // The homepage tile showed `5h 35% · 7d 83%` and NOTHING else. Both resets must be here.
  for (const w of card.windows) assert.ok(w.resetText && /resets/.test(w.resetText), `${w.label}: ${w.resetText}`);
});

test("100% is walled, a stale poll is unreadable, and neither is the other", () => {
  assert.equal(claudeCards(claudeStatus({ sevenDay: 100 }), NOW)[0].state, "walled");
  assert.match(claudeCards(claudeStatus({ sevenDay: 100 }), NOW)[0].stateNote!, /7d spent/);
  const staleCard = claudeCards(claudeStatus({}, true), NOW)[0];
  assert.equal(staleCard.state, "unreadable");
  assert.match(staleCard.stateNote!, /stale/);
  // An unread window is never 0%: the percentage stays null and Meter draws the dashed track.
  const unread = claudeCards(claudeStatus({ fiveHour: null, sevenDay: null }), NOW)[0];
  assert.equal(unread.state, "unreadable");
  assert.equal(unread.windows[0].usedPercent, null);
});

test("an expired login reads as needing one, not as spent", () => {
  const card = claudeCards(claudeStatus({ authState: "reauth-required" }), NOW)[0];
  assert.equal(card.state, "unreadable");
  assert.match(card.stateNote!, /re-login/);
  // Its windows still hold whatever was last read; the state is the claim, not the numbers.
  assert.equal(card.windows[0].usedPercent, 35);
});

test("Codex renders through the SAME card and the same field order as Claude", () => {
  const [codex] = codexCards([codexAccount()]);
  const [claude] = claudeCards(claudeStatus(), NOW);
  assert.equal(codex.provider, "Codex");
  assert.equal(codex.state, "ok");
  assert.deepEqual(codex.windows.map(w => w.label), ["7d"]); // Codex has ONE window, honestly
  assert.ok(codex.windows[0].resetText?.startsWith("resets"));
  const html = (c: typeof codex) => renderToStaticMarkup(createElement(AccountCard, { account: c }));
  // Same component, so the same markers appear for both providers.
  for (const c of [codex, claude]) {
    assert.match(html(c), /a@example\.com/);
    assert.match(html(c), /resets/);
  }
  assert.match(html(codex), /Codex/);
  assert.match(html(claude), /Claude/);
});

test("a stale Codex reading is unreadable, never a percentage", () => {
  const [card] = codexCards([codexAccount({ fresh: false })]);
  assert.equal(card.state, "unreadable");
  assert.equal(card.windows[0].usedPercent, null);
  assert.match(renderToStaticMarkup(createElement(AccountCard, { account: card })), /unknown/);
});
