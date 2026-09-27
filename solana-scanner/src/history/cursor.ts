/**
 * Opaque page cursors. "sig:<signature>" (before-signature paging) is
 * understood by every provider; "gtfa:<slot:position>" only by Helius
 * getTransactionsForAddress. A provider given a cursor it can't use restarts
 * from the top and says so (results are de-duplicated by signature).
 */

export type Cursor = { kind: "sig"; value: string } | { kind: "gtfa"; value: string };

export function encodeCursor(c: Cursor): string {
  return `${c.kind}:${c.value}`;
}

export function decodeCursor(s: string | null): Cursor | null {
  if (!s) return null;
  const i = s.indexOf(":");
  if (i < 0) return null;
  const kind = s.slice(0, i);
  const value = s.slice(i + 1);
  if (!value) return null;
  if (kind === "sig" || kind === "gtfa") return { kind, value };
  return null;
}
