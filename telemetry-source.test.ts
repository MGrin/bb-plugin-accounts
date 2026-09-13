import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCodexSnapshotReader } from "./telemetry-source.ts";

test("bounded fake mx: exact read-only argv, exit 2 JSON, deduplication, aging, failure invalidation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "accounts-telemetry-"));
  const cli = path.join(dir, "mx"), calls = path.join(dir, "calls");
  let now = 1_800_000_000;
  const data = { version: 1, observed_at: now - 1000, codex_observed_at: now, codex: "available", codex_usage: { rateLimits: {
    limitId: "codex", primary: { usedPercent: 6, resetsAt: now + 3000 }, secondary: null } } };
  try {
    await writeFile(cli, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+'\\n');\nconsole.log(${JSON.stringify(JSON.stringify(data))});\nprocess.exit(2);\n`, { mode: 0o755 });
    const read = createCodexSnapshotReader(cli, () => now);
    const results = await Promise.all([read(), read(), read()]);
    assert.ok(results.every(r => r.capacity === "available"));
    assert.equal(await readFile(calls, "utf8"), '["spawn","availability"]\n');
    now += 50; assert.equal((await read()).observedAt, data.codex_observed_at);
    await writeFile(cli, `#!${process.execPath}\nconsole.error('DO-NOT-EMIT'); process.exit(1);\n`, { mode: 0o755 });
    now += 20; const failed = await read(); assert.equal(failed.capacity, "unknown");
    assert.ok(!JSON.stringify(failed).includes("DO-NOT-EMIT"));
    await writeFile(cli, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(data))});\n`, { mode: 0o755 });
    now += 200; assert.equal((await read()).capacity, "unknown");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("missing CLI, malformed stdout, oversized response and timeout all yield UNKNOWN", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "accounts-telemetry-")); const cli = path.join(dir, "mx");
  try {
    assert.equal((await createCodexSnapshotReader(cli)()).capacity, "unknown");
    for (const source of ["console.log('garbage')", "console.log('x'.repeat(300000))", "setInterval(() => {}, 100)"]) {
      await writeFile(cli, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
      assert.equal((await createCodexSnapshotReader(cli, undefined, 150)()).capacity, "unknown");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
