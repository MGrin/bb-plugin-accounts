// The bridge between the two data spines: how many utilization points does a
// thousand tokens of a given model actually cost? Pure.
//
// Poll data says what Anthropic counted; transcripts say what was spent. Only
// their overlap can relate the two, and only fitting that relation turns 26
// days of archived transcripts from a suggestive shape into a calibrated
// backfill.

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * Collapse a model id to its family.
 *
 * Fitting per exact id would mean a new free parameter every time Anthropic
 * ships a dated build (`claude-haiku-4-5-20251001`) or a context variant
 * (`claude-opus-5[1m]`), each starting from zero observations. Families are
 * stable, few, and are what the pricing actually varies on.
 */
export function modelFamily(model: string | null | undefined): string {
  if (!model) return "other";
  const m = model.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  if (m.includes("fable")) return "fable";
  return "other";
}

/**
 * Reduce a message's four token counts to one comparable number.
 *
 * Cache reads bill at roughly a tenth of fresh input, and output at roughly
 * four times it — the published price ratios. Cache CREATION bills as input.
 * Getting these ratios roughly right matters more than it looks: they are what
 * lets a single per-family weight fit messages with wildly different cache
 * hit rates.
 */
export function weightedTokens(t: TokenCounts): number {
  return t.inputTokens + t.cacheCreationTokens + 0.1 * t.cacheReadTokens + 4 * t.outputTokens;
}

/**
 * Order-of-magnitude starting weights, in utilization points per 1k weighted
 * tokens, keyed by family.
 *
 * These are RATIOS taken from published pricing with a rough absolute anchor,
 * not measurements. They exist so a forecast on day one is not divide-by-zero,
 * and the nightly fit replaces them as real overlap accumulates. This
 * imprecision is exactly why a forecast is labelled `provisional` until the
 * poll history is deep enough to have fitted them — do not quietly promote a
 * seeded forecast to a confident one.
 */
export const SEED_PRIORS: Record<string, number> = {
  opus: 0.1,
  fable: 0.1,
  sonnet: 0.02,
  haiku: 0.0067,
  other: 0.02,
};

export interface FitObservation {
  /** Utilization points consumed over this interval. */
  deltaUtil: number;
  /** Weighted tokens, in thousands, keyed by model family. */
  tokensByModel: Record<string, number>;
}

export interface ModelWeights {
  weights: Record<string, number>;
  /** RMS of the residuals. Zero for a perfect fit. */
  residual: number;
  sampleCount: number;
}

const ITERATIONS = 500;

/**
 * Non-negative least squares by coordinate descent.
 *
 * Coordinate descent rather than gradient descent on purpose: there is no
 * learning rate to tune and no way for it to diverge on badly scaled inputs,
 * which matters because the token counts here span several orders of
 * magnitude. Each sweep solves one weight exactly given the others and clamps
 * it at zero; negative cost is not a thing a model can have, and an
 * unconstrained fit will happily produce one from noise.
 *
 * A family with no observations keeps its prior rather than collapsing to
 * zero — "never seen" and "free" are different claims.
 */
export function fitModelWeights(
  observations: FitObservation[],
  priors: Record<string, number>,
): ModelWeights {
  const families = new Set<string>(Object.keys(priors));
  for (const o of observations) for (const f of Object.keys(o.tokensByModel)) families.add(f);
  const keys = [...families].sort();

  const weights: Record<string, number> = {};
  for (const k of keys) weights[k] = priors[k] ?? 0;

  if (observations.length === 0) {
    return { weights, residual: 0, sampleCount: 0 };
  }

  // Precompute the column norms; a family that never appears has norm 0 and is
  // skipped entirely, which is what preserves its prior.
  const norm: Record<string, number> = {};
  for (const k of keys) {
    norm[k] = observations.reduce((s, o) => s + (o.tokensByModel[k] ?? 0) ** 2, 0);
  }

  const predict = (o: FitObservation): number =>
    keys.reduce((s, k) => s + (weights[k] ?? 0) * (o.tokensByModel[k] ?? 0), 0);

  for (let iter = 0; iter < ITERATIONS; iter++) {
    let moved = 0;
    for (const k of keys) {
      if (norm[k] === 0) continue;
      let dot = 0;
      for (const o of observations) {
        const x = o.tokensByModel[k] ?? 0;
        if (x === 0) continue;
        dot += x * (o.deltaUtil - predict(o));
      }
      const next = Math.max(0, (weights[k] ?? 0) + dot / norm[k]!);
      moved = Math.max(moved, Math.abs(next - (weights[k] ?? 0)));
      weights[k] = next;
    }
    if (moved < 1e-12) break;
  }

  const sse = observations.reduce((s, o) => s + (o.deltaUtil - predict(o)) ** 2, 0);
  return {
    weights,
    residual: Math.sqrt(sse / observations.length),
    sampleCount: observations.length,
  };
}
