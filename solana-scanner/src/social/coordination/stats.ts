/** Small statistics helpers. Floats are fine here: these numbers are indications, never amounts. */

/** Poisson upper tail P(X >= k) for mean lambda. Exact summation, stable for the sizes used here. */
export function poissonTail(k: number, lambda: number): number {
  if (k <= 0) return 1;
  if (!(lambda > 0)) return 0;
  // 1 - sum_{i<k} e^-l l^i / i!
  let term = Math.exp(-lambda);
  let cdf = term;
  for (let i = 1; i < k; i++) {
    term = (term * lambda) / i;
    cdf += term;
  }
  return Math.max(0, Math.min(1, 1 - cdf));
}

/** Herfindahl–Hirschman index of positive weights, in [1/n, 1]. Null for no weight. */
export function hhi(weights: readonly number[]): number | null {
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  return weights.reduce((a, w) => a + (w / total) ** 2, 0);
}

/** Gini coefficient of non-negative values in [0,1]; null if fewer than 2 values or no mass. */
export function gini(values: readonly number[]): number | null {
  const v = [...values].sort((a, b) => a - b);
  const n = v.length;
  const total = v.reduce((a, b) => a + b, 0);
  if (n < 2 || !(total > 0)) return null;
  let acc = 0;
  for (let i = 0; i < n; i++) acc += (2 * (i + 1) - n - 1) * v[i]!;
  return acc / (n * total);
}

export function mean(v: readonly number[]): number | null {
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
}

/** Coefficient of variation (population); null if fewer than 2 values or zero mean. */
export function cv(v: readonly number[]): number | null {
  const m = mean(v);
  if (m === null || v.length < 2 || m === 0) return null;
  const variance = v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length;
  return Math.sqrt(variance) / Math.abs(m);
}

/** Relative closeness of two non-negative bigint amounts: |a-b| <= tol * max(a,b). */
export function similar(a: bigint, b: bigint, tol: number): boolean {
  if (a <= 0n || b <= 0n) return false;
  const hi = a > b ? a : b;
  const lo = a > b ? b : a;
  return Number(hi - lo) <= tol * Number(hi);
}

/** mulberry32: small deterministic PRNG (same seed → same sequence). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
