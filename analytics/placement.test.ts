import { test } from "node:test";
import assert from "node:assert/strict";
import { placeWork, planPlacement, usableHeadroom, weightForModel, DEFAULT_SWITCH_AT } from "./placement.ts";
import { SEED_PRIORS } from "./calibrate.ts";

// Real weights from the model_weight calibration on this machine (fit 0.987).
const FABLE = 0.1;
const HAIKU = 0.00605655066439782;

// The exact fleet at 2026-08-15 15:30, which is why this module exists.
const REAL = [
  { slot: "mr6r1n_gmail.com", fiveUtil: 0, sevenUtil: 100, active: false },
  { slot: "nikita_withflare.xyz", fiveUtil: 0, sevenUtil: 100, active: false },
  { slot: "steve_scani.xyz", fiveUtil: 98, sevenUtil: 78, active: true },
  { slot: "nikita_scani.xyz", fiveUtil: 0, sevenUtil: 67, active: false },
];

// The trap this module exists to avoid: 5h 0% looks completely free and is
// worth nothing when the weekly window is spent.
test("an account free on 5h but capped on 7d has NO usable headroom", () => {
  assert.equal(
    usableHeadroom({ slot: "x", fiveUtil: 0, sevenUtil: 100, active: false }, DEFAULT_SWITCH_AT),
    0,
  );
});

test("headroom is bounded by whichever window is tighter", () => {
  // 5h allows 97-90=7; 7d allows 100-50=50. The binding constraint is 7.
  assert.equal(
    usableHeadroom({ slot: "x", fiveUtil: 90, sevenUtil: 50, active: false }, DEFAULT_SWITCH_AT),
    7,
  );
});

test("on the real fleet, Fable work goes to the only account with room", () => {
  const p = placeWork({ accounts: REAL, modelWeight: FABLE });
  assert.equal(p.slot, "nikita_scani.xyz");
  assert.ok(p.headroom > 0);
});

test("the two weekly-exhausted accounts are never chosen", () => {
  for (const w of [FABLE, HAIKU]) {
    const p = placeWork({ accounts: REAL, modelWeight: w });
    assert.notEqual(p.slot, "mr6r1n_gmail.com");
    assert.notEqual(p.slot, "nikita_withflare.xyz");
  }
});

// The behaviour mgrin asked for: mechanical work should consume the scraps.
test("cheap work takes the tightest slot, leaving room for what cannot fit elsewhere", () => {
  const accounts = [
    { slot: "roomy", fiveUtil: 0, sevenUtil: 0, active: false },
    { slot: "scraps", fiveUtil: 90, sevenUtil: 10, active: false },
  ];
  // Haiku: 7 points buys ~1156 units, well over the minimum, so scraps suffice.
  assert.equal(placeWork({ accounts, modelWeight: HAIKU }).slot, "scraps");
  // Fable: 7 points buys 70 units; still over the 20-unit floor, so it also fits
  // the tight slot — best-fit is about not wasting the roomy one.
  assert.equal(placeWork({ accounts, modelWeight: FABLE, minUnits: 100 }).slot, "roomy");
});

test("when nothing fits the floor it says so and still returns the best available", () => {
  const accounts = [{ slot: "thin", fiveUtil: 96, sevenUtil: 0, active: false }];
  const p = placeWork({ accounts, modelWeight: FABLE, minUnits: 1000 });
  assert.equal(p.slot, "thin");
  assert.match(p.reason, /nothing fits/);
});

test("a fully capped fleet returns null rather than a slot that cannot work", () => {
  const p = placeWork({
    accounts: [
      { slot: "a", fiveUtil: 99, sevenUtil: 100, active: true },
      { slot: "b", fiveUtil: 0, sevenUtil: 100, active: false },
    ],
    modelWeight: FABLE,
  });
  assert.equal(p.slot, null);
  assert.match(p.reason, /every slot is at a cap/);
});

// An unseen account must not be assumed empty — that would route work to a slot
// nobody has measured.
test("null utilisation is treated as full, not as free", () => {
  const p = placeWork({
    accounts: [{ slot: "unseen", fiveUtil: null, sevenUtil: null, active: false }],
    modelWeight: FABLE,
  });
  assert.equal(p.slot, null);
});

test("weeklyAt is a parameter, so placement and decideSwitch cannot disagree", () => {
  const a = { slot: "x", fiveUtil: 0, sevenUtil: 96, active: false };
  // Default wall of 100: 4 points of week left.
  assert.equal(usableHeadroom(a, DEFAULT_SWITCH_AT), 4);
  // A machine configured to stop at 95 has none.
  assert.equal(usableHeadroom(a, DEFAULT_SWITCH_AT, 95), 0);
  assert.equal(placeWork({ accounts: [a], modelWeight: FABLE, weeklyAt: 95 }).slot, null);
});

// bb hands out dated and context-tagged ids; the calibration is per family.
test("weightForModel collapses a concrete model id to its fitted family weight", () => {
  const weights = { opus: 0.00116, haiku: HAIKU };
  assert.equal(weightForModel("claude-opus-5[1m]", weights), 0.00116);
  assert.equal(weightForModel("claude-haiku-4-5-20251001", weights), HAIKU);
});

test("an unfitted or unknown model falls back to a prior, and the prior is not cheap", () => {
  // fable is not in the fitted table here; the seed prior stands in.
  assert.equal(weightForModel("claude-fable-5", { opus: 0.00116 }), SEED_PRIORS.fable);
  // A model nobody has measured must not be assumed cheap enough for scraps.
  assert.equal(weightForModel("some-new-model", {}), SEED_PRIORS.other);
  assert.equal(weightForModel(null, {}), SEED_PRIORS.other);
});

// RULE 1: placement moves work off a wall, never merely toward more room.
test("placement leaves work on an account that fits, however much roomier another is", () => {
  const accounts = [
    { slot: "active-but-adequate", fiveUtil: 50, sevenUtil: 0, active: true },
    { slot: "wide-open", fiveUtil: 0, sevenUtil: 0, active: false },
  ];
  const plan = planPlacement({
    accounts,
    modelWeight: FABLE,
    activeSlot: "active-but-adequate",
    model: "claude-fable-5",
  });
  assert.equal(plan.action, "none");
  assert.match(plan.reason, /does not move work off a slot that fits/);
});

test("placement switches when the active slot cannot hold the work and another can", () => {
  const plan = planPlacement({
    accounts: REAL,
    modelWeight: FABLE,
    activeSlot: "steve_scani.xyz",
    model: "claude-fable-5",
  });
  assert.equal(plan.action, "switch");
  assert.equal(plan.to, "nikita_scani.xyz");
});

// RULE 2: the decision mgrin delegated. An explicit choice is never silently
// undone — placement says the choice looks wrong and leaves it standing.
test("an explicitly chosen account is warned about, never switched away from", () => {
  const plan = planPlacement({
    accounts: REAL,
    modelWeight: FABLE,
    activeSlot: "steve_scani.xyz",
    activePinned: true,
    model: "claude-fable-5",
  });
  assert.equal(plan.action, "warn");
  // The warning still names where the work SHOULD have gone — a warning that
  // withholds the alternative is not actionable.
  assert.equal(plan.to, "nikita_scani.xyz");
  assert.match(plan.reason, /chosen explicitly/);
});

test("a fully capped fleet warns rather than switching sideways into another wall", () => {
  const accounts = [
    { slot: "a", fiveUtil: 99, sevenUtil: 100, active: true },
    { slot: "b", fiveUtil: 0, sevenUtil: 100, active: false },
  ];
  const plan = planPlacement({ accounts, modelWeight: FABLE, activeSlot: "a" });
  assert.equal(plan.action, "warn");
  assert.equal(plan.to, null);
  assert.match(plan.reason, /every slot is at a cap/);
});

test("no switch when the thin active slot is nonetheless the best there is", () => {
  const accounts = [
    { slot: "thin", fiveUtil: 96, sevenUtil: 0, active: true },
    { slot: "capped", fiveUtil: 0, sevenUtil: 100, active: false },
  ];
  const plan = planPlacement({ accounts, modelWeight: FABLE, activeSlot: "thin", minUnits: 100 });
  assert.equal(plan.action, "none");
  assert.equal(plan.to, null);
});

// Cheap work is exactly what SHOULD stay on the scraps — the floor is in units,
// so haiku fits where fable does not.
test("haiku stays put where fable would be moved, because the floor is in units", () => {
  const accounts = [
    { slot: "scraps", fiveUtil: 96, sevenUtil: 0, active: true },
    { slot: "roomy", fiveUtil: 0, sevenUtil: 0, active: false },
  ];
  const common = { accounts, activeSlot: "scraps", minUnits: 100 };
  assert.equal(planPlacement({ ...common, modelWeight: HAIKU }).action, "none");
  assert.equal(planPlacement({ ...common, modelWeight: FABLE }).action, "switch");
});
