/** Exact integer arithmetic. Every rounding direction is explicit; nothing uses floating point. */

export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;
export const Q64 = 1n << 64n;

export class MathError extends Error {
  code: "division_by_zero" | "overflow" | "negative";
  constructor(code: MathError["code"], message: string) {
    super(`${code}: ${message}`);
    this.name = "MathError";
    this.code = code;
  }
}

export function mulDivFloor(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new MathError("division_by_zero", "mulDivFloor");
  if (a < 0n || b < 0n || d < 0n) throw new MathError("negative", "mulDivFloor");
  return (a * b) / d;
}

export function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new MathError("division_by_zero", "mulDivCeil");
  if (a < 0n || b < 0n || d < 0n) throw new MathError("negative", "mulDivCeil");
  return (a * b + d - 1n) / d;
}

export function divCeil(a: bigint, d: bigint): bigint {
  if (d === 0n) throw new MathError("division_by_zero", "divCeil");
  if (a < 0n || d < 0n) throw new MathError("negative", "divCeil");
  return (a + d - 1n) / d;
}

export const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
export const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/** A non-negative rational, used for prices so comparisons are exact. */
export interface Ratio {
  num: bigint;
  den: bigint;
}

/** a/b ≥ c/d (all denominators positive). */
export function ratioGte(a: Ratio, b: Ratio): boolean {
  return a.num * b.den >= b.num * a.den;
}

/** Converts a ratio of raw units to a human number: (num/den) × 10^(scaleExp). Display only. */
export function ratioToNumber(r: Ratio, scaleExp = 0): number {
  if (r.den === 0n) return Number.NaN;
  // Keep 40 significant digits through BigInt before going to a float.
  const scale = 10n ** 40n;
  const q = (r.num * scale) / r.den;
  return (Number(q) / 1e40) * 10 ** scaleExp;
}

/** Raw base units → human number (display only). */
export function toHuman(raw: bigint, decimals: number): number {
  const div = 10n ** BigInt(decimals);
  const whole = raw / div;
  const frac = raw % div;
  return Number(whole) + Number(frac) / Number(div);
}

/** Human number → raw units, rounded down. */
export function fromHuman(value: number, decimals: number): bigint {
  if (!Number.isFinite(value) || value < 0) throw new MathError("negative", `fromHuman(${value})`);
  // Go through a decimal string so 0.1 + 0.2 style float noise cannot add a unit.
  const scaled = value.toFixed(Math.min(decimals, 20));
  const [w, f = ""] = scaled.split(".");
  return BigInt(w!) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}
