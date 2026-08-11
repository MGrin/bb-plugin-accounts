// Incremental transcript scanning. Impure — filesystem only, no SQL.
//
// The archive is ~550MB across ~2650 files and only its tail ever changes, so
// re-reading it every 15 minutes is not an option. Two levels of skipping:
// a file whose (size, mtime) match its cursor is never opened at all, and a
// file that has grown is read only from the byte where the last scan stopped.
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parseTranscriptLine, type TranscriptRow } from "./transcripts.ts";

export interface ScanCursor {
  size: number;
  /** Epoch milliseconds, as reported by stat().mtimeMs, floored. */
  mtime: number;
  /** Byte offset of the first UNREAD byte. Always lands on a line boundary. */
  byteOffset: number;
}

export interface ScanResult {
  filesSeen: number;
  filesRead: number;
  rowsParsed: number;
}

/** Called with each batch. Persisting rows and cursor together is the caller's job. */
export type OnBatch = (rows: TranscriptRow[], filePath: string, cursor: ScanCursor) => void;

const CHUNK = 1 << 20; // 1 MiB
const BATCH = 1000;

async function listTranscripts(root: string): Promise<string[]> {
  const out: string[] = [];
  let projects: string[];
  try {
    projects = await readdir(root);
  } catch {
    return out; // no transcripts on this machine; not an error
  }
  for (const project of projects) {
    const dir = path.join(root, project);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue; // a file where a directory was expected, or a permission blip
    }
    for (const entry of entries) {
      if (entry.endsWith(".jsonl")) out.push(path.join(dir, entry));
    }
  }
  return out.sort();
}

/**
 * Read one file forward from `from`, emitting parsed rows in batches.
 *
 * Line splitting happens on BUFFERS, not strings. A 1 MiB chunk boundary lands
 * mid-codepoint often enough at this volume, and decoding each chunk
 * independently would corrupt those characters and — worse — desynchronise the
 * byte offset, so every later scan of that file would start mid-line.
 */
async function readFrom(
  filePath: string,
  from: number,
  size: number,
  mtime: number,
  onBatch: OnBatch,
): Promise<number> {
  const sessionId = path.basename(filePath, ".jsonl");
  const project = path.basename(path.dirname(filePath));
  const handle = await open(filePath, "r");
  /** Byte offset of the first byte NOT yet handed to onBatch. Line-aligned. */
  let consumed = from;
  let rows = 0;
  let batch: TranscriptRow[] = [];
  let leftover = Buffer.alloc(0);

  try {
    const buffer = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, consumed + leftover.length);
      if (bytesRead === 0) break;
      const combined = Buffer.concat([leftover, buffer.subarray(0, bytesRead)]);
      const lastNewline = combined.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        // No complete line in this window yet. A transcript record is JSON on
        // one line and can legitimately exceed a chunk, so keep accumulating.
        leftover = combined;
        continue;
      }
      const complete = combined.subarray(0, lastNewline + 1);
      leftover = combined.subarray(lastNewline + 1);

      for (const line of complete.toString("utf8").split("\n")) {
        const row = parseTranscriptLine(line, sessionId, project);
        if (row) batch.push(row);
      }
      // Only now is `complete` fully processed, so only now may the cursor
      // move past it. Flushing mid-chunk with a not-yet-advanced offset is how
      // a crash silently skips records.
      consumed += complete.length;

      if (batch.length >= BATCH) {
        rows += batch.length;
        onBatch(batch, filePath, { size, mtime, byteOffset: consumed });
        batch = [];
      }
    }
  } finally {
    await handle.close();
  }

  // Always emit a final batch, even an empty one: it carries the cursor, and a
  // file of nothing but user turns still needs its bytes marked read or every
  // future scan re-reads them.
  //
  // The trailing partial line is deliberately NOT consumed. A transcript being
  // appended to right now ends mid-record, and claiming those bytes would drop
  // the message for good once it is complete.
  rows += batch.length;
  onBatch(batch, filePath, { size, mtime, byteOffset: consumed });
  return rows;
}

/**
 * Scan every transcript under `root`, resuming from `cursors`.
 *
 * A file that SHRANK was rotated or rewritten, so its offset is meaningless
 * and it is re-read from zero. Rows are keyed on (sessionId, messageId)
 * downstream, so a full re-read is idempotent rather than duplicating.
 */
export async function scanTranscripts(
  root: string,
  cursors: Map<string, ScanCursor>,
  onBatch: OnBatch,
): Promise<ScanResult> {
  const files = await listTranscripts(root);
  const result: ScanResult = { filesSeen: files.length, filesRead: 0, rowsParsed: 0 };

  for (const filePath of files) {
    try {
      const info = await stat(filePath);
      const size = info.size;
      const mtime = Math.floor(info.mtimeMs);
      const cursor = cursors.get(filePath);

      if (cursor && cursor.size === size && cursor.mtime === mtime) continue;

      const from = cursor && size >= cursor.size ? cursor.byteOffset : 0;
      if (from >= size) {
        // Touched but not grown — mtime moved with no new bytes. Refresh the
        // cursor so this file stops being restatted every tick.
        onBatch([], filePath, { size, mtime, byteOffset: size });
        continue;
      }
      result.filesRead++;
      result.rowsParsed += await readFrom(filePath, from, size, mtime, onBatch);
    } catch {
      // One unreadable transcript must never stop the scan. A file being
      // rotated out from under us is normal, not exceptional.
      continue;
    }
  }
  return result;
}
