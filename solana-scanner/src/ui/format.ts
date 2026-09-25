export const MISSING = "—";

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function usdCompact(n: number | null): string {
  return n === null ? MISSING : `$${compact.format(n)}`;
}

/** Memecoin prices span many orders of magnitude: keep 4 significant digits. */
export function usdPrice(n: number | null): string {
  if (n === null) return MISSING;
  if (n === 0) return "$0";
  if (Math.abs(n) >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  return `$${n.toPrecision(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}

export function count(n: number | null): string {
  return n === null ? MISSING : integer.format(n);
}

export function percent(n: number | null): string {
  if (n === null) return MISSING;
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

export function age(createdAtMs: number | null, now: number = Date.now()): string {
  if (createdAtMs === null) return MISSING;
  const s = Math.max(0, Math.floor((now - createdAtMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function shortAddress(addr: string): string {
  return addr.length <= 12 ? addr : `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}
