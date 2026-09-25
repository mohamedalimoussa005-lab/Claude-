/** Formatting used in score explanations. */

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export const ABSENT = "absent";
export const fmtPct = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(2)} %`;
export const fmtPts = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(2)} pts`;
export const fmtUsd = (n: number) => (Math.abs(n) < 10 ? `$${n.toFixed(2)}` : `$${compact.format(n)}`);
export const fmtRatio = (n: number) => `${n.toFixed(2)}×`;
export const fmtInt = (n: number) => integer.format(n);
export const fmtShare = (n: number) => `${(n * 100).toFixed(0)} %`;
export const fmtAge = (min: number) =>
  min < 60 ? `${min.toFixed(0)} min` : min < 2_880 ? `${(min / 60).toFixed(1)} h` : `${(min / 1_440).toFixed(1)} j`;
export const round1 = (n: number) => Math.round(n * 10) / 10;
