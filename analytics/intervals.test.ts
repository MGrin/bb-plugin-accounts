import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveIntervals } from "./intervals.ts";
import type { UsageSampleRow } from "./store.ts";

/** A 5h-window sample. The 7d fields stay null so a test says what it means. */
const s = (polledAt: number, fiveUtil: number | null, fiveResetsAt: string | null = null): UsageSampleRow => ({
  polledAt,
  slot: "a",
  fiveUtil,
  fiveResetsAt,
  sevenUtil: null,
  sevenResetsAt: null,
  active: 1,
});

const d7 = (polledAt: number, sevenUtil: number | null, sevenResetsAt: string | null = null): UsageSampleRow => ({
  polledAt,
  slot: "a",
  fiveUtil: null,
  fiveResetsAt: null,
  sevenUtil,
  sevenResetsAt,
  active: 1,
});

test("a rising series yields positive deltas", () => {
  const out = deriveIntervals([s(0, 10), s(100, 15), s(200, 22)], "5h");
  assert.deepEqual(out.map((i) => i.deltaUtil), [5, 7]);
  assert.deepEqual(out.map((i) => i.isReset), [false, false]);
  assert.deepEqual(out.map((i) => [i.t0, i.t1]), [[0, 100], [100, 200]]);
  assert.ok(out.every((i) => i.slot === "a" && i.window === "5h"));
});

test("a decrease marks a reset and credits only the post-reset value", () => {
  const out = deriveIntervals([s(0, 90), s(100, 12)], "5h");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.isReset, true);
  assert.equal(out[0]!.deltaUtil, 12);
});

test("a resetsAt change with no decrease is still a reset", () => {
  const out = deriveIntervals(
    [s(0, 40, "2026-08-11T09:00:00Z"), s(100, 41, "2026-08-11T14:00:00Z")],
    "5h",
  );
  assert.equal(out[0]!.isReset, true);
  assert.equal(out[0]!.deltaUtil, 41);
});

test("microsecond jitter in resetsAt is NOT a reset", () => {
  // Verbatim from the first three polls this plugin ever recorded. The poller
  // derives resetsAt as roughly now + seconds_remaining, so the same 09:50:00
  // reset arrives with a different sub-second component every time. Treating
  // that as a new window credited the full 98 points as burn, every 3 minutes.
  const out = deriveIntervals(
    [
      s(1786433268, 98, "2026-08-11T09:50:00.881236+00:00"),
      s(1786433453, 98, "2026-08-11T09:50:00.406176+00:00"),
      s(1786433638, 98, "2026-08-11T09:50:00.896950+00:00"),
    ],
    "5h",
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((i) => i.isReset), [false, false]);
  assert.deepEqual(out.map((i) => i.deltaUtil), [0, 0]);
});

test("a resetsAt that moves by a whole window IS a reset", () => {
  const out = deriveIntervals(
    [
      s(0, 40, "2026-08-11T09:50:00.100000+00:00"),
      s(100, 41, "2026-08-11T14:50:00.900000+00:00"),
    ],
    "5h",
  );
  assert.equal(out[0]!.isReset, true);
});

test("an unparseable resetsAt falls back to the utilization signal", () => {
  const rising = deriveIntervals([s(0, 40, "not-a-date"), s(100, 44, "also-not")], "5h");
  assert.equal(rising[0]!.isReset, false);
  assert.equal(rising[0]!.deltaUtil, 4);
  const dropping = deriveIntervals([s(0, 90, "not-a-date"), s(100, 4, "also-not")], "5h");
  assert.equal(dropping[0]!.isReset, true);
});

test("an unchanged resetsAt across a rise is not a reset", () => {
  const out = deriveIntervals(
    [s(0, 40, "2026-08-11T14:00:00Z"), s(100, 44, "2026-08-11T14:00:00Z")],
    "5h",
  );
  assert.equal(out[0]!.isReset, false);
  assert.equal(out[0]!.deltaUtil, 4);
});

test("a flat series yields zero-delta intervals, not nothing", () => {
  const out = deriveIntervals([s(0, 40), s(100, 40)], "5h");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.deltaUtil, 0);
  assert.equal(out[0]!.isReset, false);
});

test("null utilization breaks the series rather than counting as zero", () => {
  const out = deriveIntervals([s(0, 10), s(100, null), s(200, 30)], "5h");
  assert.equal(out.length, 0);
});

test("out-of-order and duplicate samples are normalised", () => {
  const out = deriveIntervals([s(200, 22), s(0, 10), s(100, 15), s(100, 15)], "5h");
  assert.deepEqual(out.map((i) => [i.t0, i.t1]), [[0, 100], [100, 200]]);
});

test("a zero-length interval is dropped", () => {
  const out = deriveIntervals([s(100, 10), s(100, 12)], "5h");
  assert.equal(out.length, 0);
});

test("fewer than two samples yields nothing", () => {
  assert.equal(deriveIntervals([], "5h").length, 0);
  assert.equal(deriveIntervals([s(0, 10)], "5h").length, 0);
});

test("the 7d window is read from its own columns", () => {
  const out = deriveIntervals([d7(0, 30), d7(100, 34)], "7d");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.window, "7d");
  assert.equal(out[0]!.deltaUtil, 4);
  // ...and asking for 5h on the same rows finds nothing, since those are null.
  assert.equal(deriveIntervals([d7(0, 30), d7(100, 34)], "5h").length, 0);
});
