import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { unknownCodex, unknownJev, JEV_WINDOWS } from "./telemetry.ts";
register("./tests/sdk-loader.mjs", import.meta.url);
const { default: plugin } = await import("./server.ts");

test("actual thread.failed handler ignores Codex and unknown providers before any Claude read or recovery", async () => {
  let reads = 0;
  const { bb, harness } = createFakePluginHost({ pluginId: "accounts", settings: { autoSwitch: false } });
  try {
    await plugin(bb as unknown as Parameters<typeof plugin>[0], {
      readClaudeUsage: async () => { reads++; return { polledAt: null, accounts: [] }; },
      readCodexSnapshot: async () => unknownCodex(),
    });
    for (const providerId of ["codex", "", "claude", "fake-claude"]) {
      await harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: `t-${providerId}`, providerId, status: "error" }), error: "429 usage limit reached" });
    }
    assert.equal(reads, 0);
    assert.equal(await bb.storage.kv.get("stuck-threads"), undefined);
    assert.equal(harness.inspection.sdk.calls.length, 0);
    // Positive control: exact Claude still tracks a real limit with auto-switch disabled.
    await harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "t-claude", providerId: "claude-code", status: "error" }), error: "429 usage limit reached" });
    assert.equal((await bb.storage.kv.get<any[]>("stuck-threads"))?.[0].threadId, "t-claude");
  } finally { await harness.lifecycle.dispose(); }
});

test("RPC and CLI exercise the same normalized telemetry and leave legacy status intact", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "accounts" });
  try {
    await plugin(bb as unknown as Parameters<typeof plugin>[0], { readClaudeUsage: async () => ({ polledAt: null, accounts: [] }), readCodexSnapshot: async () => unknownCodex() });
    const rpc = await harness.behavior.callRpc("telemetry", null);
    const cli = await harness.behavior.runCli(["telemetry", "--json"]);
    assert.equal(cli.exitCode, 0);
    assert.deepEqual(JSON.parse(cli.stdout!), rpc);
    assert.match((await harness.behavior.runCli(["telemetry"])).stdout!, /codex local-session/);
    const status = await harness.behavior.callRpc("status", null) as any;
    assert.equal(status.capacity, "unknown"); assert.deepEqual(status.accounts, []);
  } finally { await harness.lifecycle.dispose(); }
});

test("watch reconciliation never adopts Codex or missing providers", async () => {
  let eventReads: string[] = [];
  const now = Date.now();
  const threads = [makeThreadResponse({ id: "codex", providerId: "codex", status: "error", updatedAt: now }),
    makeThreadResponse({ id: "unknown", providerId: "", status: "error", updatedAt: now }),
    makeThreadResponse({ id: "claude", providerId: "claude-code", status: "error", updatedAt: now })];
  const { bb, harness } = createFakePluginHost({ pluginId: "accounts", sdk: { threads: {
    list: async () => threads,
    events: { list: async (args: any) => { eventReads.push(args.threadId); return [{ type: "provider/rateLimits/updated", data: { rateLimits: { providerId: "claude-code", status: "blocked" } } }]; } },
  } } });
  try {
    await plugin(bb as unknown as Parameters<typeof plugin>[0], { readClaudeUsage: async () => ({ polledAt: null, accounts: [] }), readCodexSnapshot: async () => unknownCodex() });
    await harness.behavior.runSchedule("watch");
    assert.deepEqual(eventReads, ["claude"]);
    assert.deepEqual((await bb.storage.kv.get<any[]>("stuck-threads"))?.map(t => t.threadId), ["claude"]);
  } finally { await harness.lifecycle.dispose(); }
});

test("SDK event notification reads a bounded page, keeps thread attribution, and clears on provider change", async () => {
  const now = Date.now(); let reads = 0;
  const { bb, harness } = createFakePluginHost({ pluginId: "accounts", sdk: { threads: { events: { list: async (args: any) => {
    reads++; assert.equal(args.limit, "100"); assert.equal(args.order, "desc");
    return [{ threadId: "c", createdAt: now, type: "provider/rateLimits/updated", data: { providerThreadId: "s", rateLimits: { providerId: "codex", status: "blocked", windows: [] } } }];
  } } } } });
  try {
    await plugin(bb as unknown as Parameters<typeof plugin>[0], { readClaudeUsage: async () => ({ polledAt: null, accounts: [] }), readCodexSnapshot: async () => unknownCodex() });
    const thread = makeThreadResponse({ id: "c", providerId: "codex" });
    await harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 1 });
    await harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 2 });
    assert.equal(reads, 1);
    let telemetry = await harness.behavior.callRpc("telemetry", null) as any;
    assert.equal(telemetry.accounts.length, 2); assert.equal(telemetry.accounts[1].threadId, "c");
    assert.equal(telemetry.accounts[0].capacity, "unknown");
    await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: { ...thread, providerId: "claude-code" }, sequence: 3 });
    telemetry = await harness.behavior.callRpc("telemetry", null) as any;
    assert.equal(telemetry.accounts.length, 1);
  } finally { await harness.lifecycle.dispose(); }
});

test("an in-flight SDK read cannot restore a thread after provider change", async () => {
  let finish!: (rows: any[]) => void;
  const page = new Promise<any[]>(resolve => { finish = resolve; });
  const { bb, harness } = createFakePluginHost({ pluginId: "accounts", sdk: { threads: { events: { list: async () => page } } } });
  try {
    await plugin(bb as unknown as Parameters<typeof plugin>[0], { readClaudeUsage: async () => ({ polledAt: null, accounts: [] }), readCodexSnapshot: async () => unknownCodex() });
    const thread = makeThreadResponse({ id: "c", providerId: "codex" });
    const pending = harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 1 });
    await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: { ...thread, providerId: "claude-code" }, sequence: 2 });
    finish([{ threadId: "c", createdAt: Date.now(), type: "provider/rateLimits/updated", data: { rateLimits: { providerId: "codex", windows: [] } } }]);
    await pending;
    const telemetry = await harness.behavior.callRpc("telemetry", null) as any;
    assert.equal(telemetry.accounts.length, 1);
  } finally { await harness.lifecycle.dispose(); }
});

test("Jev spend rides its own rpc and CLI verb; telemetry keeps version 1 and gains no key", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "accounts" });
  const ok = { ...unknownJev(""), state: "ok" as const, reason: "counts", generatedAt: 1_800_000_000, lastDecisionAt: 1_799_999_000,
    billing: { amountUsd: 12.5, recordedAt: 1_799_990_000, period: "Sep 2026", source: "https://console.typesafe.ai/usage", asOf: null },
    windows: JEV_WINDOWS.map(name => ({ name, since: 1_799_000_000, calls: 3, inputTokens: 1000, bySet: [] })) };
  let reading: ReturnType<typeof unknownJev> = ok;
  try {
    await plugin(bb as unknown as Parameters<typeof plugin>[0], { readClaudeUsage: async () => ({ polledAt: null, accounts: [] }),
      readCodexSnapshot: async () => unknownCodex(), readJevUsage: async () => reading });
    const telemetry = await harness.behavior.callRpc("telemetry", null) as any;
    assert.deepEqual(Object.keys(telemetry).sort(), ["accounts", "tokens", "version"]); assert.equal(telemetry.version, 1);
    assert.deepEqual(await harness.behavior.callRpc("jev", null), ok);
    const cli = await harness.behavior.runCli(["jev", "--json"]);
    assert.equal(cli.exitCode, 0); assert.deepEqual(JSON.parse(cli.stdout!), ok);
    assert.match((await harness.behavior.runCli(["jev"])).stdout!, /\$12\.50 for Sep 2026/);
    reading = unknownJev("mx not found");
    const blind = await harness.behavior.runCli(["jev"]);
    assert.equal(blind.exitCode, 0, "a report, not a gate: README, Provider-scoped telemetry"); assert.match(blind.stdout!, /UNKNOWN · mx not found/); assert.doesNotMatch(blind.stdout!, /\$/);
  } finally { await harness.lifecycle.dispose(); }
});

// MX-1226: `bb plugin list` read `accounts running (rpc status failed: rpc result at
// $result.accounts[0].error is not a JSON value (undefined))`. `error` and `authState` are
// optional in the contract, and zod accepts undefined — but the RPC wire does not: a key
// PRESENT with an undefined value is not JSON, and the real usage cache always set both
// keys. Claude's whole panel was dead.
test("status serialises accounts as JSON even when the optional fields are absent", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "accounts" });
  try {
    await plugin(bb as unknown as Parameters<typeof plugin>[0], {
      // Exactly the shape readUsageCache builds for an account with no error: the keys
      // exist and hold undefined.
      readClaudeUsage: async () => ({
        polledAt: 1_700_000_000,
        accounts: [{
          error: undefined, authState: undefined,
          slot: "one", email: "a@example.com", active: true,
          fiveHour: 12, sevenDay: 34, fiveHourResetsAt: null, sevenDayResetsAt: null,
          credits: "on" as const, creditSpend: null,
        }],
      }),
      readCodexSnapshot: async () => unknownCodex(),
    });
    const status = await harness.behavior.callRpc("status", null) as any;
    assert.equal(status.accounts.length, 1);
    // The daemon's own test: every value must survive a JSON round trip. A key holding
    // undefined vanishes, so this reds on exactly the payload that broke the panel.
    assert.deepStrictEqual(status, JSON.parse(JSON.stringify(status)));
    // Positive control: a real error still reaches the reader.
    assert.equal(status.accounts[0].email, "a@example.com");
  } finally { await harness.lifecycle.dispose(); }
});
