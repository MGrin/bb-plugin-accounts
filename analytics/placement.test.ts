import { test } from "node:test";
import assert from "node:assert/strict";
import { placeWork, usableHeadroom, DEFAULT_SWITCH_AT } from "./placement.ts";

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
