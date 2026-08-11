// One transcript JSONL line -> one billable message, or nothing. Pure.
//
// The format is undocumented and belongs to Claude Code, which upgrades on its
// own schedule. So every field is read defensively and a line that does not
// look right is skipped rather than thrown on: an indexer that dies on one bad
// line stops recording history, which is the failure this whole module exists
// to prevent.
//
// THE DEDUPE IS THE POINT. A transcript writes the same assistant message
// several times — one record per streaming update — each carrying a full,
// IDENTICAL usage block. Measured over 60 real transcripts on 2026-08-11:
// 1142 usage-bearing records collapse to 625 distinct messages. Summing the
// records instead of the messages inflates every token count by ~2x on
// average and 3.7x in the worst file, and because the factor varies per file
// it cannot be divided back out downstream. `message.id` is the identity that
// survives: present on every one of those records, never disagreeing about
// usage, never spanning more than one requestId. (requestId itself is
// sometimes absent, so it must not be part of the key.)

export interface TranscriptRow {
  sessionId: string;
  /** `message.id` — the dedupe key. See the note above; this is not decorative. */
  messageId: string;
  /** Epoch SECONDS. */
  ts: number;
  cwd: string | null;
  /** The transcript's parent directory name, which encodes the project path. */
  project: string | null;
  model: string | null;
  /**
   * How this session was launched: `sdk-cli` (a bb-spawned agent thread),
   * `cli` (a human in a terminal), `sdk-ts`, `claude-vscode`. This is the
   * agent-shape signal — see agentShape() — because `isSidechain` is not one.
   */
  entrypoint: string | null;
  /**
   * Claude Code's own Task-tool subagent flag.
   *
   * Recorded for completeness but NOT usable as the agent-shape breakdown on
   * this machine: it is `false` on all 96,985 archived records and `true` on
   * none of them, because agent work here runs as bb threads, each with its
   * own transcript, rather than as in-process sidechains.
   */
  isSidechain: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * Who actually spent this — the breakdown mgrin asked for as "main vs
 * subagent vs fleet", expressed in the terms this machine has.
 *
 * `sdk-cli` is how bb launches an agent thread, so it is every fleet worker,
 * every automation, and every spawned child. `cli` is a human at a terminal.
 * The distinction matters because it is the one that changes behaviour: a
 * fleet is what burns a 5-hour window inside a single poll interval.
 */
export function agentShape(entrypoint: string | null | undefined): string {
  switch (entrypoint) {
    case "sdk-cli":
      return "bb-agent";
    case "cli":
      return "terminal";
    case "sdk-ts":
      return "sdk";
    case "claude-vscode":
      return "ide";
    default:
      return "other";
  }
}

/** Coerce anything to a finite non-negative integer. Absent, null and "lots" all mean 0. */
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

/**
 * Parse one line. Returns null for anything that is not a billable assistant
 * message — user turns, tool results, summaries, blank lines, partial writes,
 * and records whose usage block carries no tokens at all.
 */
export function parseTranscriptLine(
  line: string,
  fallbackSessionId: string,
  project: string | null,
): TranscriptRow | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;

  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    record = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const message = record.message as Record<string, unknown> | undefined;
  const usage = message?.usage as Record<string, unknown> | undefined;
  if (!usage) return null;

  // No id means the row cannot be deduplicated, and a row that cannot be
  // deduplicated is worse than a missing one — it inflates every total it
  // lands in. Drop it.
  const messageId = typeof message?.id === "string" ? message.id : null;
  if (!messageId) return null;

  const rawTs = record.timestamp;
  const parsedTs = typeof rawTs === "string" ? Date.parse(rawTs) : Number.NaN;
  if (!Number.isFinite(parsedTs)) return null;

  const inputTokens = num(usage.input_tokens);
  const outputTokens = num(usage.output_tokens);
  const cacheReadTokens = num(usage.cache_read_input_tokens);
  const cacheCreationTokens = num(usage.cache_creation_input_tokens);
  if (inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens === 0) return null;

  return {
    sessionId: typeof record.sessionId === "string" && record.sessionId ? record.sessionId : fallbackSessionId,
    messageId,
    ts: Math.floor(parsedTs / 1000),
    cwd: typeof record.cwd === "string" ? record.cwd : null,
    project,
    model: typeof message?.model === "string" ? message.model : null,
    entrypoint: typeof record.entrypoint === "string" ? record.entrypoint : null,
    isSidechain: record.isSidechain === true,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  };
}
