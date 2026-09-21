import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeCodex, unknownCodex, normalizeJev, unknownJev, type JevSpend, type ProviderAccount } from "./telemetry.ts";
const run = promisify(execFile);

/** Read-only telemetry CLI. No inference, credentials, raw errors, auth changes or fallback routing. */
export function createCodexSnapshotReader(command: string, now = () => Date.now() / 1000, timeoutMs = 10_000) {
  let pending: Promise<ProviderAccount> | null = null;
  let attemptedAt = -Infinity;
  let cached: unknown = null;
  let failure = "Codex telemetry has not been read";
  return async (): Promise<ProviderAccount> => {
    if (pending) return pending;
    if (now() - attemptedAt < 60) return cached === null ? unknownCodex(failure) : normalizeCodex(cached, now());
    attemptedAt = now();
    pending = (async () => {
      try {
        let stdout: string;
        try {
          ({ stdout } = await run(command, ["spawn", "availability"], { timeout: timeoutMs, maxBuffer: 256 * 1024, encoding: "utf8", killSignal: "SIGKILL" }));
        } catch (error) {
          // v1 can return useful Codex data with exit 2 when Claude is unknown.
          const e = error as { code?: unknown; stdout?: unknown; killed?: boolean; signal?: unknown };
          if (e.code !== 2 || e.killed || e.signal || typeof e.stdout !== "string") throw error;
          stdout = e.stdout;
        }
        cached = JSON.parse(stdout);
        return normalizeCodex(cached, now());
      } catch {
        cached = null;
        failure = "Codex telemetry unavailable (mx missing, failed, timed out or returned invalid JSON)";
        return unknownCodex(failure);
      } finally { pending = null; }
    })();
    return pending;
  };
}

/** Why an execFile of mx failed, in words. Never its stderr: that is not ours to publish. */
function whyMxFailed(error: unknown, timeoutMs: number): string {
  const e = error as { code?: unknown; killed?: boolean; signal?: unknown };
  if (e.code === "ENOENT") return "mx not found";
  if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "mx jev usage printed more than 256 KiB";
  if (e.killed || e.signal) return `mx jev usage timed out after ${timeoutMs / 1000} s`;
  if (typeof e.code === "number") return `mx jev usage exited ${e.code}`;
  return "mx jev usage could not be run";
}

/** `mx jev usage --json`, bounded like the Codex reader. rc 2 is blind or usage: UNKNOWN, never a reading. */
export function createJevUsageReader(command: string, now = () => Date.now() / 1000, timeoutMs = 10_000) {
  let pending: Promise<JevSpend> | null = null;
  let attemptedAt = -Infinity;
  let last: JevSpend = unknownJev("Jev usage has not been read");
  return async (): Promise<JevSpend> => {
    if (pending) return pending;
    if (now() - attemptedAt < 60) return last;
    attemptedAt = now();
    pending = (async () => {
      let stdout: string;
      try {
        ({ stdout } = await run(command, ["jev", "usage", "--json"], { timeout: timeoutMs, maxBuffer: 256 * 1024, encoding: "utf8", killSignal: "SIGKILL" }));
      } catch (error) {
        return last = unknownJev(whyMxFailed(error, timeoutMs));
      } finally { pending = null; }
      let parsed: unknown;
      try { parsed = JSON.parse(stdout); } catch { return last = unknownJev("mx jev usage printed something that is not JSON"); }
      return last = normalizeJev(parsed, now());
    })();
    return pending;
  };
}
