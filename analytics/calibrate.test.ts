import { test } from "node:test";
import assert from "node:assert/strict";
import { fitModelWeights, modelFamily, SEED_PRIORS, weightedTokens } from "./calibrate.ts";

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

test("the seed priors order the families the way pricing does", () => {
  assert.ok(SEED_PRIORS.opus! > SEED_PRIORS.sonnet!);
  assert.ok(SEED_PRIORS.sonnet! > SEED_PRIORS.haiku!);
  assert.ok(Object.values(SEED_PRIORS).every((v) => v > 0));
});
