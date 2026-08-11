import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { MIGRATIONS } from "./schema.ts";
import { ingestUsage, type IngestAccount } from "./ingest.ts";
import { countDistinctPolls, readIntervals, readSamples } from "./store.ts";

function freshDb() {
  const db = new Database(":memory:");
  for (const stmt of MIGRATIONS) db.exec(stmt);
  return db;
}

const acct = (over: Partial<IngestAccount> = {}): IngestAccount => ({
  slot: "a",
  active: true,
  fiveHour: 10,
  sevenDay: 5,
  fiveHourResetsAt: null,
  sevenDayResetsAt: null,
  ...over,
});

test("a first poll records one row per account and derives nothing yet", () => {
  const db = freshDb();
  const out = ingestUsage(db, 1000, [acct({ slot: "a" }), acct({ slot: "b", active: false })]);
  assert.equal(out.inserted, 2);
  assert.equal(out.intervals, 0);
  assert.equal(countDistinctPolls(db), 1);
});

test("a second poll derives intervals for both windows", () => {
  const db = freshDb();
  ingestUsage(db, 1000, [acct({ fiveHour: 10, sevenDay: 5 })]);
  const out = ingestUsage(db, 1180, [acct({ fiveHour: 18, sevenDay: 6 })]);
  assert.equal(out.inserted, 1);
  assert.equal(out.intervals, 2);
  assert.deepEqual(readIntervals(db, "5h", 0).map((i) => i.deltaUtil), [8]);
  assert.deepEqual(readIntervals(db, "7d", 0).map((i) => i.deltaUtil), [1]);
});

test("a repeated polledAt is a no-op and skips re-derivation", () => {
  const db = freshDb();
  ingestUsage(db, 1000, [acct()]);
  ingestUsage(db, 1180, [acct({ fiveHour: 18 })]);
  const out = ingestUsage(db, 1180, [acct({ fiveHour: 18 })]);
  assert.deepEqual(out, { inserted: 0, intervals: 0 });
  assert.equal(countDistinctPolls(db), 2);
});

test("a null polledAt or no accounts records nothing", () => {
  const db = freshDb();
  assert.deepEqual(ingestUsage(db, null, [acct()]), { inserted: 0, intervals: 0 });
  assert.deepEqual(ingestUsage(db, 1000, []), { inserted: 0, intervals: 0 });
  assert.equal(countDistinctPolls(db), 0);
});

test("the active flag is recorded per account, not assumed", () => {
  const db = freshDb();
  ingestUsage(db, 1000, [acct({ slot: "a", active: false }), acct({ slot: "b", active: true })]);
  assert.equal(readSamples(db, "a", 0)[0]!.active, 0);
  assert.equal(readSamples(db, "b", 0)[0]!.active, 1);
});

test("a failed poll (null utilization) is recorded but derives no burn", () => {
  const db = freshDb();
  ingestUsage(db, 1000, [acct({ fiveHour: 10 })]);
  ingestUsage(db, 1180, [acct({ fiveHour: null, sevenDay: null })]);
  const out = ingestUsage(db, 1360, [acct({ fiveHour: 30, sevenDay: 8 })]);
  assert.equal(out.inserted, 1);
  // Both neighbouring pairs involve the null sample, so neither yields burn.
  assert.equal(readIntervals(db, "5h", 0).length, 0);
  assert.equal(countDistinctPolls(db), 3);
});

test("a window reset across polls is recorded as a reset", () => {
  const db = freshDb();
  ingestUsage(db, 1000, [acct({ fiveHour: 96 })]);
  ingestUsage(db, 1180, [acct({ fiveHour: 4 })]);
  const [row] = readIntervals(db, "5h", 0);
  assert.equal(row!.isReset, true);
  assert.equal(row!.deltaUtil, 4);
});
