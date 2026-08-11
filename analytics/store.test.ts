import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { MIGRATIONS } from "./schema.ts";
import {
  countDistinctPolls,
  insertSamples,
  latestSampleAt,
  readCursors,
  readIntervals,
  readSamples,
  transcriptCoverage,
  type UsageSampleRow,
  writeCursor,
  writeIntervals,
  writeTranscriptRows,
} from "./store.ts";
import type { BurnInterval } from "./intervals.ts";
import type { TranscriptRow } from "./transcripts.ts";

function freshDb() {
  const db = new Database(":memory:");
  for (const stmt of MIGRATIONS) db.exec(stmt);
  return db;
}

const sample = (over: Partial<UsageSampleRow> = {}): UsageSampleRow => ({
  polledAt: 100,
  slot: "a",
  fiveUtil: 10,
  fiveResetsAt: null,
  sevenUtil: 5,
  sevenResetsAt: null,
  active: 1,
  ...over,
});

test("insertSamples ignores a duplicate (polledAt, slot)", () => {
  const db = freshDb();
  const row = sample();
  assert.equal(insertSamples(db, [row]), 1);
  assert.equal(insertSamples(db, [row]), 0);
  assert.equal(readSamples(db, "a", 0).length, 1);
});

test("readSamples returns ascending by polledAt and filters by slot and time", () => {
  const db = freshDb();
  insertSamples(db, [
    sample({ polledAt: 300, fiveUtil: 30 }),
    sample({ polledAt: 100, fiveUtil: 10 }),
    sample({ polledAt: 200, slot: "b", fiveUtil: 20, active: 0 }),
  ]);
  assert.deepEqual(readSamples(db, "a", 0).map((r) => r.polledAt), [100, 300]);
  assert.deepEqual(readSamples(db, "a", 200).map((r) => r.polledAt), [300]);
  assert.deepEqual(readSamples(db, "b", 0).map((r) => r.polledAt), [200]);
});

test("nulls round-trip rather than becoming zero", () => {
  const db = freshDb();
  insertSamples(db, [sample({ polledAt: 1, fiveUtil: null, sevenUtil: null, active: 0 })]);
  const [row] = readSamples(db, "a", 0);
  assert.equal(row!.fiveUtil, null);
  assert.equal(row!.sevenUtil, null);
  assert.equal(row!.active, 0);
});

test("resetsAt strings round-trip", () => {
  const db = freshDb();
  insertSamples(db, [sample({ fiveResetsAt: "2026-08-11T09:50:00Z", sevenResetsAt: "2026-08-17T04:00:00Z" })]);
  const [row] = readSamples(db, "a", 0);
  assert.equal(row!.fiveResetsAt, "2026-08-11T09:50:00Z");
  assert.equal(row!.sevenResetsAt, "2026-08-17T04:00:00Z");
});

test("latestSampleAt and countDistinctPolls", () => {
  const db = freshDb();
  assert.equal(latestSampleAt(db), null);
  assert.equal(countDistinctPolls(db), 0);
  insertSamples(db, [
    sample({ polledAt: 100, slot: "a" }),
    sample({ polledAt: 100, slot: "b", active: 0 }),
    sample({ polledAt: 200, slot: "a" }),
  ]);
  assert.equal(latestSampleAt(db), 200);
  assert.equal(countDistinctPolls(db), 2);
});

test("insertSamples on an empty array is a no-op", () => {
  const db = freshDb();
  assert.equal(insertSamples(db, []), 0);
});

const interval = (over: Partial<BurnInterval> = {}): BurnInterval => ({
  slot: "a",
  window: "5h",
  t0: 0,
  t1: 100,
  deltaUtil: 5,
  isReset: false,
  ...over,
});

test("intervals round-trip, and isReset survives as a boolean", () => {
  const db = freshDb();
  writeIntervals(db, [interval({ isReset: true, deltaUtil: 12 })]);
  const [row] = readIntervals(db, "5h", 0);
  assert.equal(row!.isReset, true);
  assert.equal(typeof row!.isReset, "boolean");
  assert.equal(row!.deltaUtil, 12);
  assert.equal(row!.window, "5h");
});

test("re-deriving the same tail replaces rather than duplicates", () => {
  const db = freshDb();
  writeIntervals(db, [interval({ deltaUtil: 5 })]);
  writeIntervals(db, [interval({ deltaUtil: 7 })]);
  const rows = readIntervals(db, "5h", 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.deltaUtil, 7);
});

test("readIntervals filters by window and start time, ascending", () => {
  const db = freshDb();
  writeIntervals(db, [
    interval({ t0: 200, t1: 300 }),
    interval({ t0: 0, t1: 100 }),
    interval({ window: "7d", t0: 0, t1: 100 }),
  ]);
  assert.deepEqual(readIntervals(db, "5h", 0).map((r) => r.t1), [100, 300]);
  assert.deepEqual(readIntervals(db, "5h", 150).map((r) => r.t1), [300]);
  assert.deepEqual(readIntervals(db, "7d", 0).map((r) => r.t1), [100]);
});

test("intervals for different slots at the same t1 coexist", () => {
  const db = freshDb();
  writeIntervals(db, [interval({ slot: "a" }), interval({ slot: "b" })]);
  assert.equal(readIntervals(db, "5h", 0).length, 2);
});

const tRow = (over: Partial<TranscriptRow> = {}): TranscriptRow => ({
  sessionId: "s1",
  messageId: "m1",
  ts: 1000,
  cwd: "/tmp",
  project: "p",
  model: "claude-opus-5",
  entrypoint: "sdk-cli",
  isSidechain: false,
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheCreationTokens: 4,
  ...over,
});

test("the same (sessionId, messageId) is written once — this is the dedupe", () => {
  const db = freshDb();
  assert.equal(writeTranscriptRows(db, [tRow()]), 1);
  assert.equal(writeTranscriptRows(db, [tRow({ outputTokens: 999 })]), 0);
  assert.equal(transcriptCoverage(db).messages, 1);
});

test("the same messageId in a different session is a different message", () => {
  const db = freshDb();
  writeTranscriptRows(db, [tRow({ sessionId: "s1" }), tRow({ sessionId: "s2" })]);
  assert.equal(transcriptCoverage(db).messages, 2);
});

test("transcriptCoverage reports the recorded span", () => {
  const db = freshDb();
  assert.deepEqual(transcriptCoverage(db), { messages: 0, firstTs: null, lastTs: null });
  writeTranscriptRows(db, [tRow({ messageId: "a", ts: 500 }), tRow({ messageId: "b", ts: 1500 })]);
  assert.deepEqual(transcriptCoverage(db), { messages: 2, firstTs: 500, lastTs: 1500 });
});

test("cursors round-trip and overwrite by path", () => {
  const db = freshDb();
  assert.equal(readCursors(db).size, 0);
  writeCursor(db, "/a.jsonl", { size: 10, mtime: 20, byteOffset: 5 });
  writeCursor(db, "/b.jsonl", { size: 1, mtime: 2, byteOffset: 1 });
  writeCursor(db, "/a.jsonl", { size: 30, mtime: 40, byteOffset: 25 });
  const cursors = readCursors(db);
  assert.equal(cursors.size, 2);
  assert.deepEqual(cursors.get("/a.jsonl"), { size: 30, mtime: 40, byteOffset: 25 });
});

test("writeTranscriptRows on an empty batch is a no-op", () => {
  const db = freshDb();
  assert.equal(writeTranscriptRows(db, []), 0);
});
