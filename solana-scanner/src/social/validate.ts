/** Format checks for the values the ledger anchors evidence to. Pure, no I/O. */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 → bytes, or null when the string is not valid base58. */
export function base58Decode(s: string): Uint8Array | null {
  if (s.length === 0) return null;
  let n = 0n;
  for (const ch of s) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** A Solana public key: base58 that decodes to exactly 32 bytes. */
export function isSolanaAddress(s: unknown): s is string {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  return base58Decode(s)?.length === 32;
}

/** A transaction signature: base58 that decodes to exactly 64 bytes. */
export function isSignature(s: unknown): s is string {
  if (typeof s !== "string" || s.length < 80 || s.length > 90) return false;
  return base58Decode(s)?.length === 64;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Strict ISO 8601 UTC timestamp ("Z" only), as a valid calendar instant. Returns epoch ms or null. */
export function parseIsoUtc(s: unknown): number | null {
  if (typeof s !== "string" || !ISO_UTC.test(s)) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  // Reject rolled-over dates such as 2026-02-31 (Date.parse would not).
  const back = new Date(t).toISOString().slice(0, 19);
  return back === s.slice(0, 19) ? t : null;
}
