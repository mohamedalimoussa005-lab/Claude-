/** Program-derived addresses (ed25519 off-curve search). Pure BigInt arithmetic + sha256; no signing, no keys. */

import { createHash } from "node:crypto";
import { base58Encode } from "../social/depth/bytes.ts";

const P = 2n ** 255n - 19n;
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error("invalid base58 character");
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  for (const c of s) {
    if (c !== "1") break;
    zeros++;
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes]);
}

function modpow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  let x = b % m;
  let k = e;
  while (k > 0n) {
    if (k & 1n) r = (r * x) % m;
    x = (x * x) % m;
    k >>= 1n;
  }
  return r;
}
const inv = (a: bigint): bigint => modpow(((a % P) + P) % P, P - 2n, P);
const D = (((-121665n * inv(121666n)) % P) + P) % P;

/** True when the 32 bytes decode to a point on the ed25519 curve (so they cannot be a PDA). */
export function onCurve(bytes: Uint8Array): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]!);
  y &= (1n << 255n) - 1n;
  const u = (((y * y - 1n) % P) + P) % P;
  const v = (D * y * y + 1n) % P;
  const t = modpow((u * inv(v)) % P, (P - 1n) / 2n, P);
  return t === 1n || t === 0n;
}

export function findProgramAddress(seeds: readonly Uint8Array[], programId: string): string {
  const prog = base58Decode(programId);
  const tag = new TextEncoder().encode("ProgramDerivedAddress");
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump)).update(prog).update(tag);
    const digest = new Uint8Array(h.digest());
    if (!onCurve(digest)) return base58Encode(digest);
  }
  throw new Error("no valid bump seed");
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
