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

const NOW = Date.now();

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

test('Codex cards expire a retained RPC observation and its active marker',()=>{
 const at=Math.floor(Date.now()/1000);
 const fresh={...codexAccount(),active:true,observedAt:at};
 const live=codexCards([fresh]);assert.equal(live[0].active,true);
 const stale=codexCards([{...fresh,observedAt:at-181}]);
 assert.equal(stale[0].state,'unreadable');assert.equal(stale[0].active,false);
 assert.equal(stale[0].windows[0].usedPercent,null);
});

test("providers format the same reset instant identically",()=>{
 const reset=Math.floor(NOW/1000)+400000;
 const claude=claudeCards(claudeStatus({sevenDayResetsAt:new Date(reset*1000).toISOString()}),NOW)[0];
 const codex=codexCards([codexAccount()],NOW)[0];
 assert.equal(claude.windows[1].resetText,codex.windows[0].resetText);
});

// ── MX-1527: a paused account is shown, marked, muted — never hidden, never an alarm ─────────
const NOW_S = Math.floor(NOW / 1000);
const pausedClaude = (over: Record<string, unknown> = {}) => claudeStatus({
  active: false, fiveHour: null, sevenDay: null, fiveHourResetsAt: null, sevenDayResetsAt: null,
  paused: { at: NOW_S - 4 * 3600 }, lastRead: { at: NOW_S - 3 * 3600, fiveHour: 41, sevenDay: 22 }, ...over,
} as any);
const html = (c: Parameters<typeof AccountCard>[0]["account"], props: object = {}) =>
  renderToStaticMarkup(createElement(AccountCard, { account: c, ...props }));

test("a paused Claude account keeps its last read, dimmed, with its age, and is not unreadable even on a stale poll", () => {
  const [card] = claudeCards(pausedClaude(), NOW);
  assert.equal(card.state, "paused");
  assert.match(card.stateNote!, /last read 3h ago/);
  assert.deepEqual(card.windows.map(w => w.usedPercent), [41, 22]);
  assert.equal(card.paused?.at, NOW_S - 4 * 3600);
  assert.deepEqual(card.control, { provider: "claude-code", slot: "one", active: false });
  // The whole cache being stale does not turn a paused row into an alarm.
  assert.equal(claudeCards(pausedClaude({}), NOW)[0].state, "paused");
  assert.equal(claudeCards({ ...pausedClaude(), stale: true }, NOW)[0].state, "paused");
  const markup = html(card);
  assert.match(markup, /PAUSED/); assert.match(markup, /41%/); assert.match(markup, /last read 3h ago/);
  assert.doesNotMatch(markup, /destructive/, "muted, not red");
  assert.doesNotMatch(markup, /reset time unknown|resets /, "an old window's reset says nothing now");
  assert.match(markup, /opacity-60/, "last-known usage is dimmed");
});

test("a paused account with no last read says so and shows unknown, never 0%", () => {
  const [card] = claudeCards(pausedClaude({ lastRead: undefined }), NOW);
  assert.equal(card.state, "paused");
  assert.match(card.stateNote!, /no last read/);
  assert.deepEqual(card.windows.map(w => w.usedPercent), [null, null]);
  assert.match(html(card), /unknown/);
});

test("the pause control: Pause on an idle account, disabled with a reason on the active one, Resume when paused", () => {
  const idle = claudeCards(claudeStatus({ active: false }), NOW)[0];
  const active = claudeCards(claudeStatus({ active: true }), NOW)[0];
  const paused = claudeCards(pausedClaude(), NOW)[0];
  const noop = () => {};
  assert.doesNotMatch(html(idle), /<button/, "no handler, no button (read-only embeds)");
  assert.match(html(idle, { onSetPaused: noop }), /<button[^>]*>Pause<\/button>/);
  assert.doesNotMatch(html(idle, { onSetPaused: noop }), /disabled=""/);
  const a = html(active, { onSetPaused: noop });
  assert.match(a, /<button[^>]*disabled=""[^>]*>Pause<\/button>/); assert.match(a, /switch away first/);
  assert.match(html(paused, { onSetPaused: noop }), /<button[^>]*>Resume<\/button>/);
  assert.match(html(paused, { onSetPaused: noop, busy: true }), /<button[^>]*disabled=""[^>]*>Resume<\/button>/);
  assert.match(html(idle, { onSetPaused: noop, message: "refusing: active" }), /refusing: active/);
});

test("a paused Codex account is paused, last-known and controllable; an unpaused slotless one has no control", () => {
  const paused = codexAccount({ slot: "two", active: false, fresh: false, capacity: "unknown", paused: { at: NOW_S - 600 },
    observedAt: NOW_S - 1800 });
  const [card] = codexCards([paused], NOW);
  assert.equal(card.state, "paused");
  assert.equal(card.windows[0].usedPercent, 33, "the previous observation, shown as last-known");
  assert.match(card.stateNote!, /last read 30m ago/);
  assert.deepEqual(card.control, { provider: "codex", slot: "two", active: false });
  assert.equal(card.active, false);
  assert.equal(codexCards([codexAccount()], NOW)[0].control, undefined);
  assert.deepEqual(codexCards([codexAccount({ slot: "one", active: true })], NOW)[0].control, { provider: "codex", slot: "one", active: true });
});

test("an active Codex login whose observation went stale still cannot be paused", () => {
  const [card] = codexCards([codexAccount({ slot: "one", active: true, fresh: false })], NOW);
  assert.equal(card.active, false, "the badge needs a fresh reading");
  assert.equal(card.control?.active, true, "the pause guard reads the raw marker, not the badge");
  assert.match(html(card, { onSetPaused: () => {} }), /<button[^>]*disabled=""/);
});
