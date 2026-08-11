import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanTranscripts, type ScanCursor } from "./scan.ts";
import type { TranscriptRow } from "./transcripts.ts";

let counter = 0;
const msg = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    timestamp: "2026-08-11T10:00:00.000Z",
    isSidechain: false,
    message: { id: `msg_${++counter}`, model: "claude-opus-5", usage: { output_tokens: 10, input_tokens: 1 } },
    ...over,
  }) + "\n";

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "scan-test-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }
  return root;
}

/** Collects batches the way server.ts does: rows accumulate, cursors overwrite. */
function collector() {
  const rows: TranscriptRow[] = [];
  const cursors = new Map<string, ScanCursor>();
  return {
    rows,
    cursors,
    onBatch: (batch: TranscriptRow[], file: string, cursor: ScanCursor) => {
      rows.push(...batch);
      cursors.set(file, cursor);
    },
  };
}

test("finds transcripts two levels down and parses their messages", async (t) => {
  const root = await fixture({ "proj-a/sess1.jsonl": msg() + msg(), "proj-b/sess2.jsonl": msg() });
  t.after(() => rm(root, { recursive: true, force: true }));
  const c = collector();
  const res = await scanTranscripts(root, c.cursors, c.onBatch);
  assert.equal(res.filesSeen, 2);
  assert.equal(res.filesRead, 2);
  assert.equal(c.rows.length, 3); // two messages in sess1, one in sess2
  assert.deepEqual(c.rows.map((r) => r.project).sort(), ["proj-a", "proj-a", "proj-b"]);
  assert.equal(c.rows[0]!.sessionId, "sess1");
});

test("a second scan with unchanged files reads nothing", async (t) => {
  const root = await fixture({ "p/s.jsonl": msg() + msg() });
  t.after(() => rm(root, { recursive: true, force: true }));
  const c = collector();
  await scanTranscripts(root, c.cursors, c.onBatch);
  const before = c.rows.length;
  const res = await scanTranscripts(root, c.cursors, c.onBatch);
  assert.equal(res.filesRead, 0);
  assert.equal(c.rows.length, before);
});

test("appended lines are read incrementally, not from the start", async (t) => {
  const root = await fixture({ "p/s.jsonl": msg() });
  t.after(() => rm(root, { recursive: true, force: true }));
  const c = collector();
  await scanTranscripts(root, c.cursors, c.onBatch);
  assert.equal(c.rows.length, 1);

  await new Promise((r) => setTimeout(r, 10));
  await appendFile(path.join(root, "p/s.jsonl"), msg());
  const res = await scanTranscripts(root, c.cursors, c.onBatch);
  assert.equal(res.filesRead, 1);
  assert.equal(c.rows.length, 2);
  assert.notEqual(c.rows[0]!.messageId, c.rows[1]!.messageId);
});

test("a trailing partial line is not consumed until it is complete", async (t) => {
  const root = await fixture({ "p/s.jsonl": msg() + '{"timestamp":"2026-08-11T10:00:00Z","mess' });
  t.after(() => rm(root, { recursive: true, force: true }));
  const c = collector();
  await scanTranscripts(root, c.cursors, c.onBatch);
  assert.equal(c.rows.length, 1);
  const cursor = c.cursors.get(path.join(root, "p/s.jsonl"))!;
  assert.ok(cursor.byteOffset < cursor.size, "partial line must stay unread");

  // Complete the record; the next scan picks it up whole.
  await new Promise((r) => setTimeout(r, 10));
  await appendFile(
    path.join(root, "p/s.jsonl"),
    'age":{"id":"msg_late","usage":{"output_tokens":5}}}\n',
  );
  await scanTranscripts(root, c.cursors, c.onBatch);
  assert.equal(c.rows.length, 2);
  assert.equal(c.rows[1]!.messageId, "msg_late");
});

test("a file that shrank is re-read from zero", async (t) => {
  const root = await fixture({ "p/s.jsonl": msg() + msg() + msg() });
  t.after(() => rm(root, { recursive: true, force: true }));
  const c = collector();
  await scanTranscripts(root, c.cursors, c.onBatch);
  assert.equal(c.rows.length, 3);

  await new Promise((r) => setTimeout(r, 10));
  await writeFile(path.join(root, "p/s.jsonl"), msg());
  c.rows.length = 0;
  await scanTranscripts(root, c.cursors, c.onBatch);
  assert.equal(c.rows.length, 1, "rewritten file re-read from the top");
});

test("malformed lines are skipped without stopping the file", async (t) => {
  const root = await fixture({ "p/s.jsonl": msg() + "{not json\n" + "\n" + msg() });
  t.after(() => rm(root, { recursive: true, force: true }));
  const c = collector();
  await scanTranscripts(root, c.cursors, c.onBatch);
  assert.equal(c.rows.length, 2);
});

test("multibyte characters spanning a read boundary survive", async (t) => {
  // A long unicode field forces the record well past any single-line assumption
  // and puts continuation bytes at awkward offsets.
  const wide = "日本語テキスト".repeat(500);
  const root = await fixture({
    "p/s.jsonl":
      JSON.stringify({
        timestamp: "2026-08-11T10:00:00Z",
        cwd: `/tmp/${wide}`,
        message: { id: "msg_wide", model: "m", usage: { output_tokens: 7 } },
      }) + "\n" + msg(),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const c = collector();
  await scanTranscripts(root, c.cursors, c.onBatch);
  assert.equal(c.rows.length, 2);
  assert.equal(c.rows[0]!.messageId, "msg_wide");
  assert.ok(c.rows[0]!.cwd!.includes("日本語"));
});

test("a missing root is not an error", async () => {
  const c = collector();
  const res = await scanTranscripts("/nonexistent/path/for/sure", c.cursors, c.onBatch);
  assert.equal(res.filesSeen, 0);
  assert.equal(c.rows.length, 0);
});

test("non-jsonl files are ignored", async (t) => {
  const root = await fixture({ "p/s.jsonl": msg(), "p/notes.md": "hello\n", "p/s.jsonl.bak": msg() });
  t.after(() => rm(root, { recursive: true, force: true }));
  const c = collector();
  const res = await scanTranscripts(root, c.cursors, c.onBatch);
  assert.equal(res.filesSeen, 1);
  assert.equal(c.rows.length, 1);
});

test("the cursor is recorded even for a file with no billable messages", async (t) => {
  const root = await fixture({ "p/s.jsonl": '{"type":"user","timestamp":"2026-08-11T10:00:00Z"}\n' });
  t.after(() => rm(root, { recursive: true, force: true }));
  const c = collector();
  await scanTranscripts(root, c.cursors, c.onBatch);
  const cursor = c.cursors.get(path.join(root, "p/s.jsonl"));
  assert.ok(cursor, "a cursor must be persisted or the file is re-read forever");
  assert.equal(cursor.byteOffset, cursor.size);
});
