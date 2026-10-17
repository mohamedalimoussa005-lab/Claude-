/**
 * Offline derivation of Solana addresses: associated token accounts (ATA), by program-derived address (PDA).
 * No network, no dependency: SHA-256 from node:crypto and a BigInt Ed25519 "is this a curve point" test that follows
 * Solana's own rule (curve25519-dalek decompression), so a PDA is a hash that is NOT on the curve.
 *
 * Why it exists: a rent deposit may be attributed to the wallet only if the account that received it IS one of the
 * wallet's token accounts. That is a relation between accounts (address = f(owner, mint)), not a lamport amount.
 * A wrong derivation can only make the proof fail (the rent then stays "uncertain"); it can never invent a match.
 */

import { createHash } from "node:crypto";
import { base58Encode } from "../../onchain/base58.ts";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const v = INDEX.get(ch);
    if (v === undefined) throw new Error("invalid base58 character");
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  for (const ch of s) {
    if (ch !== "1") break;
    zeros++;
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes]);
}

export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

// ─── Ed25519 curve membership ────────────────────────────────────────────

const P = 2n ** 255n - 19n;
const mod = (a: bigint) => ((a % P) + P) % P;

function pow(base: bigint, exp: bigint): bigint {
  let r = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
const inv = (a: bigint) => pow(a, P - 2n);
const D = mod(-121665n * inv(121666n));

/** true when the 32 bytes encode a point of the Ed25519 curve (a real public key is always one). */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) throw new Error("expected 32 bytes");
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  y &= (1n << 255n) - 1n; // the top bit is the sign of x
  y = mod(y);
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const x2 = (u * inv(v)) % P;
  return x2 === 0n || pow(x2, (P - 1n) / 2n) === 1n;
}

// ─── PDA ─────────────────────────────────────────────────────────────────

const MARKER = new TextEncoder().encode("ProgramDerivedAddress");

export function findProgramAddress(seeds: Uint8Array[], programId: string): { address: string; bump: number } {
  const program = base58Decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump));
    h.update(program);
    h.update(MARKER);
    const out = new Uint8Array(h.digest());
    if (!isOnCurve(out)) return { address: base58Encode(out), bump };
  }
  throw new Error("no viable bump seed");
}

const cache = new Map<string, string>();

/** The associated token account of `owner` for `mint` under a token program. */
export function deriveAta(owner: string, mint: string, tokenProgram: string = TOKEN_PROGRAM_ID): string {
  const key = `${owner}|${mint}|${tokenProgram}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { address } = findProgramAddress([base58Decode(owner), base58Decode(tokenProgram), base58Decode(mint)], ATA_PROGRAM_ID);
  cache.set(key, address);
  return address;
}
