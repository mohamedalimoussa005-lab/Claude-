import type { Curve } from "./config.ts";

/** Piecewise-linear interpolation, clamped at both ends. */
export function interpolate(curve: Curve, x: number): number {
  if (curve.length === 0) return 0;
  if (x <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [x1, y1] = curve[i];
    if (x <= x1) {
      const [x0, y0] = curve[i - 1];
      return x1 === x0 ? y1 : y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return curve[curve.length - 1][1];
}
