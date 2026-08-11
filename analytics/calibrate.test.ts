import { test } from "node:test";
import assert from "node:assert/strict";
import { buildObservations, fitModelWeights, modelFamily, SEED_PRIORS, weightedTokens } from "./calibrate.ts";

test("weightedTokens discounts cache reads and weights output up", () => {
  const z = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  assert.equal(weightedTokens({ ...z, inputTokens: 100 }), 100);
  assert.equal(weightedTokens({ ...z, cacheCreationTokens: 100 }), 100);
  assert.equal(weightedTokens({ ...z, cacheReadTokens: 1000 }), 100);
  assert.equal(weightedTokens({ ...z, outputTokens: 25 }), 100);
  assert.equal(weightedTokens(z), 0);
});

test("modelFamily collapses dated and suffixed ids", () => {
  assert.equal(modelFamily("claude-opus-5"), "opus");
  assert.equal(modelFamily("claude-opus-5[1m]"), "opus");
  assert.equal(modelFamily("claude-haiku-4-5-20251001"), "haiku");
  assert.equal(modelFamily("claude-sonnet-5"), "sonnet");
  assert.equal(modelFamily("claude-fable-5"), "fable");
  assert.equal(modelFamily("us.anthropic.claude-opus-5-v1:0"), "opus");
  assert.equal(modelFamily("something-else"), "other");
  assert.equal(modelFamily(null), "other");
});

test("recovers known weights from synthetic observations", () => {
  const truth = { opus: 2.0, sonnet: 0.5 };
  const obs = [
    { opus: 10, sonnet: 0 },
    { opus: 0, sonnet: 20 },
    { opus: 5, sonnet: 10 },
    { opus: 3, sonnet: 3 },
    { opus: 7, sonnet: 1 },
  ].map((tokensByModel) => ({
    tokensByModel,
    deltaUtil: tokensByModel.opus * truth.opus + tokensByModel.sonnet * truth.sonnet,
  }));
  const fit = fitModelWeights(obs, {});
  assert.ok(Math.abs(fit.weights.opus! - 2.0) < 0.05, `opus was ${fit.weights.opus}`);
  assert.ok(Math.abs(fit.weights.sonnet! - 0.5) < 0.05, `sonnet was ${fit.weights.sonnet}`);
  assert.ok(fit.residual < 0.01, `residual was ${fit.residual}`);
  assert.equal(fit.sampleCount, 5);
});

test("recovers weights from noisy observations", () => {
  const truth = { opus: 3.0 };
  const noise = [0.2, -0.15, 0.1, -0.05, 0.12, -0.2, 0.03, -0.08];
  const obs = noise.map((n, i) => ({
    tokensByModel: { opus: i + 1 },
    deltaUtil: (i + 1) * truth.opus + n,
  }));
  const fit = fitModelWeights(obs, {});
  assert.ok(Math.abs(fit.weights.opus! - 3.0) < 0.1, `opus was ${fit.weights.opus}`);
});

test("never returns a negative weight", () => {
  const fit = fitModelWeights(
    [
      { deltaUtil: 0, tokensByModel: { a: 100 } },
      { deltaUtil: -5, tokensByModel: { a: 50 } },
    ],
    {},
  );
  assert.ok(fit.weights.a! >= 0, `weight was ${fit.weights.a}`);
});

test("a model with no observations falls back to its prior", () => {
  const fit = fitModelWeights([{ deltaUtil: 10, tokensByModel: { a: 5 } }], { b: 1.7 });
  assert.equal(fit.weights.b, 1.7);
  assert.ok(fit.weights.a! > 0);
});

test("no observations at all returns the priors unchanged", () => {
  const fit = fitModelWeights([], SEED_PRIORS);
  assert.deepEqual(fit.weights, SEED_PRIORS);
  assert.equal(fit.sampleCount, 0);
});

test("observations with no tokens at all cannot move a weight", () => {
  const fit = fitModelWeights([{ deltaUtil: 50, tokensByModel: {} }], { a: 1.0 });
  assert.equal(fit.weights.a, 1.0);
});

const message = (ts: number, model: string | null, outputTokens: number) => ({
  ts,
  model,
  inputTokens: 0,
  outputTokens,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

test("buildObservations attributes messages to the interval containing them", () => {
  const obs = buildObservations(
    [{ t0: 0, t1: 100, deltaUtil: 5 }, { t0: 100, t1: 200, deltaUtil: 9 }],
    [message(10, "claude-opus-5", 250), message(150, "claude-sonnet-5", 500)],
  );
  assert.equal(obs.length, 2);
  // 250 output tokens * 4 / 1000 = 1.0 thousand weighted
  assert.deepEqual(obs[0], { deltaUtil: 5, tokensByModel: { opus: 1 } });
  assert.deepEqual(obs[1], { deltaUtil: 9, tokensByModel: { sonnet: 2 } });
});

test("buildObservations is half-open: t0 inclusive, t1 exclusive", () => {
  const obs = buildObservations(
    [{ t0: 100, t1: 200, deltaUtil: 1 }],
    [message(99, "claude-opus-5", 250), message(100, "claude-opus-5", 250), message(200, "claude-opus-5", 250)],
  );
  assert.deepEqual(obs[0]!.tokensByModel, { opus: 1 });
});

test("buildObservations sums several models inside one interval", () => {
  const obs = buildObservations(
    [{ t0: 0, t1: 100, deltaUtil: 5 }],
    [message(10, "claude-opus-5", 250), message(20, "claude-opus-5", 250), message(30, "claude-haiku-4-5", 250)],
  );
  assert.deepEqual(obs[0]!.tokensByModel, { opus: 2, haiku: 1 });
});

test("buildObservations yields an empty token map for an interval with no messages", () => {
  const obs = buildObservations([{ t0: 0, t1: 100, deltaUtil: 3 }], []);
  assert.deepEqual(obs, [{ deltaUtil: 3, tokensByModel: {} }]);
});

test("buildObservations handles overlapping intervals from different slots", () => {
  // Two slots can produce intervals covering the same wall-clock span.
  const obs = buildObservations(
    [{ t0: 0, t1: 100, deltaUtil: 5 }, { t0: 0, t1: 100, deltaUtil: 0 }],
    [message(50, "claude-opus-5", 250)],
  );
  assert.deepEqual(obs[0]!.tokensByModel, { opus: 1 });
  assert.deepEqual(obs[1]!.tokensByModel, { opus: 1 });
});

test("a fit over buildObservations output recovers a planted weight", () => {
  const perThousand = 2.5;
  const intervals = [];
  const messages = [];
  for (let i = 0; i < 8; i++) {
    const tokens = 250 * (i + 1); // -> (i+1) thousand weighted
    intervals.push({ t0: i * 100, t1: i * 100 + 100, deltaUtil: (i + 1) * perThousand });
    messages.push(message(i * 100 + 10, "claude-opus-5", tokens));
  }
  const fit = fitModelWeights(buildObservations(intervals, messages), {});
  assert.ok(Math.abs(fit.weights.opus! - perThousand) < 0.01, `opus was ${fit.weights.opus}`);
});

test("the seed priors order the families the way pricing does", () => {
  assert.ok(SEED_PRIORS.opus! > SEED_PRIORS.sonnet!);
  assert.ok(SEED_PRIORS.sonnet! > SEED_PRIORS.haiku!);
  assert.ok(Object.values(SEED_PRIORS).every((v) => v > 0));
});
