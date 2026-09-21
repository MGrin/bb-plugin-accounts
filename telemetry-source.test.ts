import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCodexSnapshotReader, createJevUsageReader } from "./telemetry-source.ts";

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

const jevReading = (now: number) => ({ version: 1, generated_at: now, source: "s", log_present: true, last_decision_ts: now - 60,
  estimate: true, usd_per_mtok: 0.042, covers: "mx jev only", windows: ["24h", "7d", "30d"].map(name =>
    ({ name, since: now - 86_400, calls: 3, input_tokens: 1000, usd: 0.000042, by_set: [] })) });

test("Jev reader: exact read-only argv, deduplication, 60 s throttle, and a failure never keeps the old figure", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "accounts-jev-"));
  const cli = path.join(dir, "mx"), calls = path.join(dir, "calls");
  let now = 1_800_000_000;
  const data = jevReading(now);
  try {
    await writeFile(cli, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+'\\n');\nconsole.log(${JSON.stringify(JSON.stringify(data))});\n`, { mode: 0o755 });
    const read = createJevUsageReader(cli, () => now);
    const results = await Promise.all([read(), read(), read()]);
    assert.ok(results.every(r => r.state === "ok"));
    assert.equal(await readFile(calls, "utf8"), '["jev","usage","--json"]\n');
    now += 50; assert.equal((await read()).state, "ok");
    assert.equal(await readFile(calls, "utf8"), '["jev","usage","--json"]\n', "throttled: no second spawn inside 60 s");
    await writeFile(cli, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(data))}); console.error('DO-NOT-EMIT'); process.exit(2);\n`, { mode: 0o755 });
    now += 20; const failed = await read();
    assert.equal(failed.state, "unknown"); assert.match(failed.reason, /exited 2/);
    assert.deepEqual(failed.windows, []);
    assert.ok(!JSON.stringify(failed).includes("DO-NOT-EMIT"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Jev reader: missing, not JSON, oversized and slow each say why they are UNKNOWN", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "accounts-jev-")); const cli = path.join(dir, "mx");
  try {
    const missing = await createJevUsageReader(cli)();
    assert.equal(missing.state, "unknown"); assert.match(missing.reason, /not found/);
    // Only the slow case gets a short timeout: node's own startup under a parallel test run can exceed 150 ms.
    const cases: [string, RegExp, number][] = [["console.log('garbage')", /not JSON/, 5000], ["console.log('x'.repeat(300000))", /256 KiB/, 5000],
      ["setInterval(() => {}, 100)", /timed out/, 300]];
    for (const [source, reason, timeout] of cases) {
      await writeFile(cli, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
      const r = await createJevUsageReader(cli, undefined, timeout)();
      assert.equal(r.state, "unknown", source); assert.match(r.reason, reason, source);
    }
    // Control: the same harness with a good reading is ok, so the refusals above are not the harness failing.
    await writeFile(cli, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(jevReading(Math.floor(Date.now() / 1000))))});\n`, { mode: 0o755 });
    assert.equal((await createJevUsageReader(cli)()).state, "ok");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
