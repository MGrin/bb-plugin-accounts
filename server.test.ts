import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { unknownCodex } from "./telemetry.ts";
register("./tests/sdk-loader.mjs", import.meta.url);
const { default: plugin, usageFromRaw } = await import("./server.ts");

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

function codexRows() {
  const now=Date.now()/1000;
  return ['one','two'].map((slot,i)=>({...unknownCodex(),providerId:'codex' as const,scope:'account' as const,
    accountId:slot,slot,active:i===0,fresh:true,observedAt:now,capacity:'available' as const,
    windows:[{bucket:'codex',key:'primary',usedPercent:i===0?99:10,resetsAt:now+3600,durationMinutes:300,reportedStatus:null}]}));
}
test('Codex RPC and manual CLI preserve slots, use expected identity, and cooldown auto decisions',async()=>{
  let calls:string[][]=[];
  const {bb,harness}=createFakePluginHost({pluginId:'accounts',settings:{autoSwitch:false,codexAutoSwitch:true}});
  try {
    await plugin(bb as any,{readClaudeUsage:async()=>({polledAt:null,accounts:[]}),readCodexSlots:async()=>codexRows(),
      runCodexAccount:async (args:string[])=>{calls.push(args);return JSON.stringify({from:'one',to:'two',changed:true});}} as any);
    const data=await harness.behavior.callRpc('telemetry',null) as any;
    assert.deepEqual(data.accounts.map((a:any)=>a.slot),['one','two']);
    const result=await harness.behavior.runCli(['codex','use','two']);
    assert.equal(result.exitCode,0); assert.deepEqual(calls,[['use','two','--expected-current','one']]);
    await harness.behavior.runSchedule('watch');
    assert.equal(calls.length,1,'manual switch starts the shared Codex cooldown');
  } finally {await harness.lifecycle.dispose();}
});
test('Codex watch switches once when enabled and ignores unknown rows',async()=>{
  let calls=0;
  const {bb,harness}=createFakePluginHost({pluginId:'accounts',settings:{autoSwitch:false,codexAutoSwitch:true}});
  try {
    let rows=codexRows();
    await plugin(bb as any,{readClaudeUsage:async()=>({polledAt:null,accounts:[]}),readCodexSlots:async()=>rows,
      runCodexAccount:async(args:string[])=>{assert.ok(args.includes('--require-free'));calls++;return JSON.stringify({from:'one',to:'two',changed:true});}} as any);
    rows[1]!.fresh=false; await harness.behavior.runSchedule('watch'); assert.equal(calls,0);
    rows=codexRows(); await harness.behavior.runSchedule('watch'); assert.equal(calls,1);
    await harness.behavior.runSchedule('watch'); assert.equal(calls,1);
  } finally {await harness.lifecycle.dispose();}
});

test('Codex history records with switching disabled and RPC remains provider-scoped',async()=>{
 const {bb,harness}=createFakePluginHost({pluginId:'accounts',settings:{autoSwitch:false,codexAutoSwitch:false}});
 try {
  await plugin(bb as any,{readClaudeUsage:async()=>({polledAt:null,accounts:[]}),readCodexSlots:async()=>codexRows()});
  await harness.behavior.runSchedule('watch');
  const fc=await harness.behavior.callRpc('codexForecast',null) as any[];
  assert.equal(fc.length,2);assert.ok(fc.every(f=>f.confidence==='provisional'&&f.polls>=1));
  const analytics=await harness.behavior.callRpc('analytics',{days:7}) as any;
  assert.deepEqual(analytics.codex.byModel,[]);assert.equal(analytics.codex.coverage.responses,0);
 }finally{await harness.lifecycle.dispose();}
});

test('forecast reads seed current Codex history before the watch tick and retain UNKNOWN identity on read failure',async()=>{
 const {bb,harness}=createFakePluginHost({pluginId:'accounts',settings:{autoSwitch:false}});
 let failed=false;
 try {
  await plugin(bb as any,{readClaudeUsage:async()=>({polledAt:null,accounts:[]}),readCodexSlots:async()=>{
   if(failed)throw new Error('simulated read timeout');
   return codexRows();
  }});
  const first=await harness.behavior.callRpc('codexForecast',null) as any[];
  assert.deepEqual(first.map(f=>f.accountId),['one','two']);
  failed=true;
  const second=await harness.behavior.callRpc('codexForecast',null) as any[];
  assert.deepEqual(second.map(f=>f.accountId),['one','two']);
  assert.ok(second.every(f=>f.confidence==='stale'&&f.points.length===0));
 }finally{await harness.lifecycle.dispose();}
});

// Direct claude-acct use and native login never write the plugin's KV record.
test('status and log report the newest observed login change, without rewriting switch policy', async () => {
 const {bb,harness}=createFakePluginHost({pluginId:'accounts'});
 let polledAt=Math.floor(Date.now()/1000)-10;
 const older=polledAt-600;
 const known={at:(older-300)*1000,from:'a',to:'b',reason:'manual via bb accounts switch'};
 try {
  await bb.storage.kv.set('last-switch',known);
  await plugin(bb as any,{readClaudeUsage:async()=>({polledAt,accounts:[{
   slot:'a',email:'a@example.com',active:true,fiveHour:10,sevenDay:3,fiveHourResetsAt:null,sevenDayResetsAt:null,credits:'off',creditSpend:null}]}),
   readCodexSnapshot:async()=>unknownCodex()});
  const db=bb.storage.database();
  db.prepare('INSERT INTO usage_sample (polled_at,slot,active) VALUES (?,?,1)').run(older,'b');
  const status=await harness.behavior.callRpc('status',null) as any;
  assert.equal(status.lastSwitch.from,'b');assert.equal(status.lastSwitch.to,'a');
  assert.equal(status.lastSwitch.at,polledAt*1000,'poll timestamp is seconds, switch timestamp is milliseconds');
  assert.match(status.lastSwitch.reason,/observed/);
  db.prepare('INSERT INTO usage_sample (polled_at,slot,active) VALUES (?,?,1)').run(polledAt,'a');
  polledAt+=5;
  const again=await harness.behavior.callRpc('status',null) as any;
  assert.equal(again.lastSwitch.at,status.lastSwitch.at,'unchanged polls cannot move the change time');
  assert.match((await harness.behavior.runCli(['log'])).stdout!,/b -> a/);
  assert.deepEqual(await bb.storage.kv.get('last-switch'),known,'observation does not pin placement or change cooldown');
  const exact={at:(older+30)*1000,from:'b',to:'a',reason:'manual via bb accounts switch'};
  await bb.storage.kv.set('last-switch',exact);
  assert.deepEqual((await harness.behavior.callRpc('status',null) as any).lastSwitch,exact,
   'a known switch between the two polls retains its exact time and source');
  const newer={at:Date.now(),from:'b',to:'a',reason:'manual via bb accounts switch'};
  await bb.storage.kv.set('last-switch',newer);
  assert.deepEqual((await harness.behavior.callRpc('status',null) as any).lastSwitch,newer);
 } finally {await harness.lifecycle.dispose();}
});

// ── MX-1527: pause an account ───────────────────────────────────────────────────────────
// Paused = NO request of any kind on that account, shown everywhere marked PAUSED, never an
// alarm. mgrin's act: the plugin refuses to pause/resume on its own and surfaces the
// dotfiles CLI's refusals verbatim.
const nowSec = () => Math.floor(Date.now() / 1000);
const row = (slot: string, over: Record<string, unknown> = {}) => ({
  slot, email: `${slot}@example.com`, active: false, fiveHour: 10, sevenDay: 10,
  fiveHourResetsAt: null, sevenDayResetsAt: null, credits: "off" as const, creditSpend: null, ...over,
});
const pausedRow = (slot: string, over: Record<string, unknown> = {}) => row(slot, {
  fiveHour: null, sevenDay: null, credits: "unknown" as const,
  paused: { at: nowSec() - 3 * 3600 },
  lastRead: { at: nowSec() - (3 * 3600 + 5 * 60), fiveHour: 41, sevenDay: 22 }, ...over,
});
const fleet = (...accounts: any[]) => async () => ({ polledAt: nowSec(), accounts });

test("usageFromRaw reads paused and lastGood onto the account, with no undefined on the wire", () => {
  const out = usageFromRaw({
    polledAt: 5,
    accounts: [
      { slot: "p", email: "p@example.com", active: false, paused: { at: 100 },
        lastGood: { at: 90, fiveHour: { util: 41, resetsAt: "x" }, sevenDay: { util: 22, resetsAt: "y" } } },
      // Rate-limited rows already carry lastGood today, alongside an error.
      { slot: "r", email: "r@example.com", active: true, error: "429", fiveHour: null, sevenDay: null,
        lastGood: { at: 80, fiveHour: { util: 100 }, sevenDay: { util: 50 } } },
      { slot: "o", email: "o@example.com", active: false, fiveHour: { util: 1 }, sevenDay: { util: 2 } },
    ],
  });
  const [p, r, o] = out.accounts as any[];
  assert.deepEqual(p.paused, { at: 100 });
  assert.deepEqual(p.lastRead, { at: 90, fiveHour: 41, sevenDay: 22 });
  assert.equal(p.error, undefined); assert.equal(p.fiveHour, null);
  assert.deepEqual(r.lastRead, { at: 80, fiveHour: 100, sevenDay: 50 });
  assert.ok(!("paused" in r) && !("lastRead" in o) && !("paused" in o), "absent means absent, never undefined");
  assert.deepStrictEqual(out, JSON.parse(JSON.stringify(out)));
  // A malformed lastGood is no last read, never a fabricated one.
  const bad = usageFromRaw({ accounts: [{ slot: "b", email: "b@x", active: false, paused: { at: 1 }, lastGood: { at: "soon" } as any }] });
  assert.ok(!("lastRead" in bad.accounts[0]!));
});

test("status shows a paused account marked paused and does not let it blind the verdict", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "accounts" });
  try {
    await plugin(bb as any, { readClaudeUsage: fleet(row("a", { active: true, fiveHour: 100, sevenDay: 100, credits: "off" }), pausedRow("p")), readCodexSnapshot: async () => unknownCodex() });
    const status = await harness.behavior.callRpc("status", null) as any;
    assert.equal(status.accounts.length, 2, "shown, not hidden");
    assert.deepEqual(status.accounts[1].paused.at > 0, true);
    assert.deepEqual(status.accounts[1].lastRead.fiveHour, 41);
    assert.equal(status.capacity, "none", "a paused account is neither capacity nor a blind spot");
    assert.deepStrictEqual(status, JSON.parse(JSON.stringify(status)));
  } finally { await harness.lifecycle.dispose(); }
});

test("bb accounts list marks the paused row with its last read and age, and the JSON carries the fields", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "accounts" });
  try {
    await plugin(bb as any, { readClaudeUsage: fleet(row("a", { active: true }), pausedRow("p"), pausedRow("q", { lastRead: undefined })), readCodexSnapshot: async () => unknownCodex() });
    const text = (await harness.behavior.runCli(["list"])).stdout!;
    assert.match(text, /^  p\s+PAUSED since .+ — no requests \(last read 5h 41% 7d 22%, 3h05m ago\)$/m);
    assert.match(text, /^  q\s+PAUSED since .+ — no requests \(last read UNKNOWN\)$/m);
    assert.doesNotMatch(text, /p\s+5h/, "no usage bars for a row that was not read");
    assert.match(text, /▶ a\s+5h/);
    const json = JSON.parse((await harness.behavior.runCli(["list", "--json"])).stdout!);
    const p = json.accounts.find((a: any) => a.slot === "p");
    assert.ok(p.paused.at > 0); assert.equal(p.lastRead.sevenDay, 22);
    assert.equal(json.capacity, "free");
  } finally { await harness.lifecycle.dispose(); }
});

test("outage ignores a paused account: not unknown, not an outage by itself, and listed as paused", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "accounts" });
  try {
    await plugin(bb as any, { readClaudeUsage: fleet(row("a", { active: true, fiveHour: 100, sevenDay: 100 }), pausedRow("p", { fiveHour: 0, sevenDay: 0 })), readCodexSnapshot: async () => unknownCodex() });
    const j = JSON.parse((await harness.behavior.runCli(["outage", "--json"])).stdout!);
    assert.equal(j.capacity, "none"); assert.equal(j.cannotServe, true);
    assert.equal(j.confirmed, false, "one poll never confirms");
    assert.deepEqual(j.accounts.map((a: any) => a.slot), ["a"]);
    const t = (await harness.behavior.runCli(["outage"])).stdout!;
    assert.match(t, /p\s+PAUSED — not counted/);
  } finally { await harness.lifecycle.dispose(); }
});

test("switch to a paused slot is refused in the plugin, names resume, and never calls claude-acct", async () => {
  const calls: string[][] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "accounts" });
  try {
    await plugin(bb as any, { readClaudeUsage: fleet(row("a", { active: true }), pausedRow("p")), readCodexSnapshot: async () => unknownCodex(),
      runClaudeAccount: async (args: string[]) => { calls.push(args); return ""; } });
    const r = await harness.behavior.runCli(["switch", "p"]);
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stderr!, /paused/); assert.match(r.stderr!, /bb accounts resume p/);
    assert.deepEqual(calls, []);
    // Positive control: an unpaused slot still switches.
    assert.equal((await harness.behavior.runCli(["switch", "a"])).exitCode, 0);
    assert.deepEqual(calls[0], ["use", "a", "--expected-current", "a"]);
  } finally { await harness.lifecycle.dispose(); }
});

test("pause and resume call claude-acct, surface its refusal, and appear in the help list", async () => {
  const calls: string[][] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "accounts" });
  let spec: any;
  const register = (bb as any).cli.register.bind((bb as any).cli);
  (bb as any).cli.register = (s: any) => { spec = s; return register(s); };
  try {
    await plugin(bb as any, { readClaudeUsage: fleet(row("a", { active: true }), row("b")), readCodexSnapshot: async () => unknownCodex(),
      runClaudeAccount: async (args: string[]) => {
        calls.push(args);
        if (args[1] === "a") throw Object.assign(new Error("Command failed"), { stderr: "refusing to pause the active account 'a'\n", code: 2 });
        return `${args[0] === "pause" ? "paused" : "resumed"}: ${args[1]}\n`;
      } });
    const ok = await harness.behavior.runCli(["pause", "b"]);
    assert.equal(ok.exitCode, 0); assert.match(ok.stdout!, /paused: b/);
    const back = await harness.behavior.runCli(["resume", "b"]);
    assert.equal(back.exitCode, 0); assert.match(back.stdout!, /resumed: b/);
    assert.deepEqual(calls, [["pause", "b"], ["resume", "b"]]);
    const refused = await harness.behavior.runCli(["pause", "a"]);
    assert.notEqual(refused.exitCode, 0); assert.match(refused.stderr!, /refusing to pause the active account/);
    assert.notEqual((await harness.behavior.runCli(["pause"])).exitCode, 0, "needs a slot");
    assert.ok(spec, "the CLI spec was registered");
    for (const usage of ["bb accounts pause <slot>", "bb accounts resume <slot>", "bb accounts codex use <slot> | pause <slot> | resume <slot> | auto"])
      assert.ok(spec.commands.some((c: any) => c.usage === usage), `help lists: ${usage}`);
  } finally { await harness.lifecycle.dispose(); }
});

test("the pause and resume RPCs return ok/message for both providers, refusals included", async () => {
  const claude: string[][] = []; const codex: string[][] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "accounts" });
  try {
    await plugin(bb as any, { readClaudeUsage: fleet(row("a", { active: true })), readCodexSlots: async () => codexRows(),
      runClaudeAccount: async (args: string[]) => { claude.push(args); if (args[1] === "a") throw Object.assign(new Error("x"), { stderr: "refusing: active\n" }); return `paused: ${args[1]}\n`; },
      runCodexAccount: async (args: string[]) => { codex.push(args); return JSON.stringify({ slot: args[1], paused: args[0] === "pause" }); } } as any);
    assert.deepEqual(await harness.behavior.callRpc("pause", { provider: "claude-code", slot: "b" }), { ok: true, message: "paused: b" });
    assert.deepEqual(await harness.behavior.callRpc("pause", { provider: "claude-code", slot: "a" }), { ok: false, message: "refusing: active" });
    assert.deepEqual(await harness.behavior.callRpc("resume", { provider: "codex", slot: "two" }), { ok: true, message: "resumed: two" });
    assert.deepEqual(await harness.behavior.callRpc("pause", { provider: "codex", slot: "two" }), { ok: true, message: "paused: two" });
    assert.deepEqual(claude, [["pause", "b"], ["pause", "a"]]); assert.deepEqual(codex, [["resume", "two"], ["pause", "two"]]);
  } finally { await harness.lifecycle.dispose(); }
});

test("codex pause/resume run codex-acct; codex use of a paused slot is refused without calling it", async () => {
  const calls: string[][] = [];
  const rows = codexRows(); (rows[1] as any).paused = { at: nowSec() - 60 }; (rows[1] as any).capacity = "unknown"; rows[1]!.fresh = false;
  const { bb, harness } = createFakePluginHost({ pluginId: "accounts", settings: { autoSwitch: false } });
  try {
    await plugin(bb as any, { readClaudeUsage: async () => ({ polledAt: null, accounts: [] }), readCodexSlots: async () => rows,
      runCodexAccount: async (args: string[]) => { calls.push(args); return JSON.stringify({ slot: args[1], paused: args[0] === "pause" }); } } as any);
    const used = await harness.behavior.runCli(["codex", "use", "two"]);
    assert.equal(used.exitCode, 2); assert.match(used.stderr!, /bb accounts codex resume two/);
    assert.deepEqual(calls, []);
    const p = await harness.behavior.runCli(["codex", "pause", "one"]);
    assert.equal(p.exitCode, 0); assert.match(p.stdout!, /paused: one/);
    const r = await harness.behavior.runCli(["codex", "resume", "two"]);
    assert.equal(r.exitCode, 0); assert.match(r.stdout!, /resumed: two/);
    assert.deepEqual(calls, [["pause", "one"], ["resume", "two"]]);
    const tel = await harness.behavior.callRpc("telemetry", null) as any;
    assert.deepStrictEqual(tel, JSON.parse(JSON.stringify(tel)));
    assert.match((await harness.behavior.runCli(["telemetry"])).stdout!, /PAUSED/);
  } finally { await harness.lifecycle.dispose(); }
});

test("watch never switches toward, or records a sample for, a paused account", async () => {
  const calls: string[][] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "accounts" });
  try {
    await plugin(bb as any, {
      readClaudeUsage: fleet(row("a", { active: true, fiveHour: 99, sevenDay: 50 }), pausedRow("p", { fiveHour: 0, sevenDay: 0 })),
      readCodexSnapshot: async () => unknownCodex(),
      runClaudeAccount: async (args: string[]) => { calls.push(args); return args[0] === "current" ? "a\n" : ""; } });
    await harness.behavior.runSchedule("watch");
    assert.ok(!calls.some((c) => c[0] === "use"), `no switch toward a paused slot: ${JSON.stringify(calls)}`);
    const db = bb.storage.database();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM usage_sample WHERE slot = ?").get("p") as any).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM usage_sample WHERE slot = ?").get("a") as any).n, 1);
  } finally { await harness.lifecycle.dispose(); }
});

test("a fine active account beside a paused one raises no alarm and switches nothing", async () => {
  const calls: string[][] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "accounts" });
  try {
    await plugin(bb as any, {
      readClaudeUsage: fleet(row("a", { active: true, fiveHour: 20, sevenDay: 20 }), pausedRow("p")),
      readCodexSnapshot: async () => unknownCodex(),
      runClaudeAccount: async (args: string[]) => { calls.push(args); return args[0] === "current" ? "a\n" : ""; } });
    await harness.behavior.runSchedule("watch");
    assert.equal(await bb.storage.kv.get("cornered-since"), undefined);
    assert.ok(!calls.some((c) => c[0] === "use"));
  } finally { await harness.lifecycle.dispose(); }
});

test("the forecast leaves paused accounts out, and is null when nothing is in service", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "accounts" });
  try {
    await plugin(bb as any, { readClaudeUsage: fleet(pausedRow("p"), pausedRow("q")), readCodexSnapshot: async () => unknownCodex() });
    assert.equal(await harness.behavior.callRpc("forecast", null), null);
  } finally { await harness.lifecycle.dispose(); }
});
