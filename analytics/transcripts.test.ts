import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscriptLine } from "./transcripts.ts";

/** Shaped from a real record — see the TOP KEYS/MSG KEYS survey in the plan. */
const REAL = JSON.stringify({
  type: "assistant",
  timestamp: "2026-07-30T05:37:15.869Z",
  cwd: "/Users/mgrin/Projects/mgrin/bb-plugin-accounts",
  sessionId: "sess-from-record",
  isSidechain: false,
  requestId: "req_1",
  message: {
    id: "msg_01ABC",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 6971,
      cache_read_input_tokens: 22860,
      output_tokens: 1062,
      server_tool_use: { web_search_requests: 0 },
      iterations: [{ input_tokens: 10, output_tokens: 1062 }],
    },
  },
});

test("parses a real assistant record", () => {
  const row = parseTranscriptLine(REAL, "sess-from-filename", "proj");
  assert.ok(row);
  assert.equal(row.messageId, "msg_01ABC");
  assert.equal(row.ts, Math.floor(Date.parse("2026-07-30T05:37:15.869Z") / 1000));
  assert.equal(row.model, "claude-haiku-4-5-20251001");
  assert.equal(row.cwd, "/Users/mgrin/Projects/mgrin/bb-plugin-accounts");
  assert.equal(row.project, "proj");
  assert.equal(row.inputTokens, 10);
  assert.equal(row.cacheCreationTokens, 6971);
  assert.equal(row.cacheReadTokens, 22860);
  assert.equal(row.outputTokens, 1062);
  assert.equal(row.isSidechain, false);
});

test("prefers the record's own sessionId over the filename", () => {
  assert.equal(parseTranscriptLine(REAL, "sess-from-filename", null)!.sessionId, "sess-from-record");
});

test("falls back to the filename sessionId when the record omits one", () => {
  const line = JSON.stringify({
    timestamp: "2026-07-30T05:37:15Z",
    message: { id: "m1", usage: { output_tokens: 1 } },
  });
  assert.equal(parseTranscriptLine(line, "sess-from-filename", null)!.sessionId, "sess-from-filename");
});

test("returns null for a record with no usage block", () => {
  const line = JSON.stringify({ type: "user", timestamp: "2026-08-11T10:00:00Z", message: { id: "m" } });
  assert.equal(parseTranscriptLine(line, "s", null), null);
});

test("returns null for a record with usage but no message id — it cannot be deduped", () => {
  const line = JSON.stringify({ timestamp: "2026-08-11T10:00:00Z", message: { usage: { output_tokens: 5 } } });
  assert.equal(parseTranscriptLine(line, "s", null), null);
});

test("returns null for malformed JSON rather than throwing", () => {
  assert.equal(parseTranscriptLine("{not json", "s", null), null);
  assert.equal(parseTranscriptLine("", "s", null), null);
  assert.equal(parseTranscriptLine("   ", "s", null), null);
  assert.equal(parseTranscriptLine("null", "s", null), null);
  assert.equal(parseTranscriptLine("[1,2,3]", "s", null), null);
});

test("returns null when the timestamp is missing or unparseable", () => {
  const noTs = JSON.stringify({ message: { id: "m", usage: { output_tokens: 1 } } });
  const badTs = JSON.stringify({ timestamp: "nope", message: { id: "m", usage: { output_tokens: 1 } } });
  assert.equal(parseTranscriptLine(noTs, "s", null), null);
  assert.equal(parseTranscriptLine(badTs, "s", null), null);
});

test("missing token fields default to zero, not NaN", () => {
  const line = JSON.stringify({
    timestamp: "2026-08-11T10:00:00Z",
    message: { id: "m", model: "m1", usage: { output_tokens: 5 } },
  });
  const row = parseTranscriptLine(line, "s", null);
  assert.ok(row);
  assert.equal(row.inputTokens, 0);
  assert.equal(row.cacheReadTokens, 0);
  assert.equal(row.cacheCreationTokens, 0);
  assert.equal(row.outputTokens, 5);
});

test("a usage block with no tokens at all is still null — nothing was billed", () => {
  const line = JSON.stringify({
    timestamp: "2026-08-11T10:00:00Z",
    message: { id: "m", usage: { server_tool_use: { web_search_requests: 0 } } },
  });
  assert.equal(parseTranscriptLine(line, "s", null), null);
});

test("isSidechain is read from the top level and defaults false", () => {
  const on = JSON.stringify({
    timestamp: "2026-08-11T10:00:00Z",
    isSidechain: true,
    message: { id: "m", usage: { output_tokens: 1 } },
  });
  const off = JSON.stringify({
    timestamp: "2026-08-11T10:00:00Z",
    message: { id: "m", usage: { output_tokens: 1 } },
  });
  assert.equal(parseTranscriptLine(on, "s", null)!.isSidechain, true);
  assert.equal(parseTranscriptLine(off, "s", null)!.isSidechain, false);
});

test("a missing model is null rather than a guess", () => {
  const line = JSON.stringify({
    timestamp: "2026-08-11T10:00:00Z",
    message: { id: "m", usage: { output_tokens: 1 } },
  });
  assert.equal(parseTranscriptLine(line, "s", null)!.model, null);
});

test("non-numeric token values are coerced to zero rather than NaN", () => {
  const line = JSON.stringify({
    timestamp: "2026-08-11T10:00:00Z",
    message: { id: "m", usage: { output_tokens: 5, input_tokens: "lots" } },
  });
  const row = parseTranscriptLine(line, "s", null);
  assert.equal(row!.inputTokens, 0);
  assert.ok(Number.isFinite(row!.inputTokens));
});
