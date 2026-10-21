import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeCodexSlots } from "./telemetry.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeCodex, unknownCodex, type ProviderAccount } from "./telemetry.ts";
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

/** Private usage cache only: no credentials or inference, bounded even during a concurrent write. */
export function createCodexSlotReader(file: string, now = () => Date.now()/1000) {
  return async (): Promise<ProviderAccount[]> => {
    try {
      const handle = await open(file, 'r');
      try {
        if ((await handle.stat()).size > 262144) throw new Error('large');
        const buffer = Buffer.alloc(262145);
        const { bytesRead } = await handle.read(buffer,0,buffer.length,0);
        if (bytesRead > 262144) throw new Error('large');
        return normalizeCodexSlots(JSON.parse(buffer.subarray(0,bytesRead).toString('utf8')),now());
      } finally { await handle.close(); }
    } catch { return [unknownCodex('Codex slot cache unavailable; capture and poll accounts')]; }
  };
}
