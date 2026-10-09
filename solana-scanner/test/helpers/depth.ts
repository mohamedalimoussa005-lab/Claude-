import { createHash } from "node:crypto";
import { base58Encode, base64ToBytes } from "../../src/social/depth/bytes.ts";
import { buildClmmVenue, buildCpmmVenue, buildPumpVenue } from "../../src/social/depth/snapshot.ts";
import type { AccountMap, BuiltVenue } from "../../src/social/depth/snapshot.ts";
import { ACCOUNTS, EPOCH, F_TICK_ARRAYS, MINTS, POOLS, PUMP_CANONICAL_CREATOR, PUMP_FEE_CONFIG, PUMP_GLOBAL_CONFIG } from "../fixtures/social/depth/raw.ts";

/** Deterministic PRNG (mulberry32): property tests are reproducible. */
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

/** Random bigint in [lo, hi], log-uniform so that tiny and huge amounts are both covered. */
export function randLog(rng: () => number, lo: bigint, hi: bigint): bigint {
  const l = Math.log(Number(lo));
  const h = Math.log(Number(hi));
  const v = BigInt(Math.floor(Math.exp(l + rng() * (h - l))));
  return v < lo ? lo : v > hi ? hi : v;
}

export const accounts = ACCOUNTS as unknown as AccountMap;

export const venueF = (): BuiltVenue => buildClmmVenue({ poolAddress: POOLS.F, baseMint: MINTS.F, accounts, tickArrays: Object.values(F_TICK_ARRAYS), ticksComplete: true, epoch: EPOCH });
export const venueB = (): BuiltVenue => buildCpmmVenue({ poolAddress: POOLS.B, baseMint: MINTS.B, accounts, epoch: EPOCH });
export const venuePump = (k: "A" | "C"): BuiltVenue => buildPumpVenue({ poolAddress: POOLS[k], accounts, globalConfigAddress: PUMP_GLOBAL_CONFIG, feeConfigAddress: PUMP_FEE_CONFIG, canonicalCreator: PUMP_CANONICAL_CREATOR[k], epoch: EPOCH });

export const bytesOf = (address: string): Uint8Array => base64ToBytes(ACCOUNTS[address]!.data);

// ───────── independent Program Derived Address derivation (to cross-check the fixtures) ─────────
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}
const P = 2n ** 255n - 19n;
const pow = (b: bigint, e: bigint, m: bigint) => {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
};
function onCurve(h: Uint8Array): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(h[i]!);
  y &= (1n << 255n) - 1n;
  const d = (((-121665n * pow(121666n, P - 2n, P)) % P) + P) % P;
  const u = (y * y - 1n + P) % P;
  const v = (d * y * y + 1n) % P;
  const x2 = (u * pow(v, P - 2n, P)) % P;
  const leg = pow(x2, (P - 1n) / 2n, P);
  return leg === 1n || leg === 0n;
}
export function findProgramAddress(seeds: Uint8Array[], program: string): string {
  const prog = b58decode(program);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump)).update(prog).update("ProgramDerivedAddress");
    const out = new Uint8Array(h.digest());
    if (!onCurve(out)) return base58Encode(out);
  }
  throw new Error("no bump");
}
export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const poolAuthorityPda = (baseMint: string) => findProgramAddress([new TextEncoder().encode("pool-authority"), b58decode(baseMint)], PUMP_PROGRAM);
