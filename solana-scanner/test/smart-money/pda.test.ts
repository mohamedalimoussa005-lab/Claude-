import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { base58Encode } from "../../src/onchain/base58.ts";
import { addr, USDC_MINT } from "../../src/smart-money/demo/fixtures.ts";
import { ATA_PROGRAM_ID, base58Decode, deriveAta, findProgramAddress, isOnCurve, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../../src/smart-money/solana/pda.ts";

const hex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

test("base58: round trip, leading zeros, and invalid characters", () => {
  for (let i = 0; i < 200; i++) {
    const b = new Uint8Array(randomBytes(32));
    assert.deepEqual([...base58Decode(base58Encode(b))], [...b]);
  }
  const zeros = new Uint8Array(32);
  assert.equal(base58Encode(zeros), "1".repeat(32));
  assert.deepEqual([...base58Decode("1".repeat(32))], [...zeros]);
  assert.equal(base58Decode(TOKEN_PROGRAM_ID).length, 32);
  assert.throws(() => base58Decode("0OIl"), /invalid base58/);
});

test("Ed25519 curve test: RFC 8032 public keys and 300 freshly generated keys are on the curve", () => {
  assert.equal(isOnCurve(hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")), true); // RFC 8032 test 1
  assert.equal(isOnCurve(hex("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c")), true); // RFC 8032 test 2
  for (let i = 0; i < 300; i++) {
    const { publicKey } = generateKeyPairSync("ed25519");
    assert.equal(isOnCurve(new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32))), true);
  }
});

test("Ed25519 curve test: about half of random 32-byte strings are NOT points (so the test discriminates)", () => {
  let on = 0;
  for (let i = 0; i < 600; i++) if (isOnCurve(new Uint8Array(randomBytes(32)))) on++;
  assert.ok(on > 600 * 0.38 && on < 600 * 0.62, `${on}/600 on curve`);
  assert.throws(() => isOnCurve(new Uint8Array(31)), /32 bytes/);
});

test("a program-derived address is never on the curve, is deterministic, and follows the documented hash", () => {
  const seeds = [base58Decode(addr(11)), base58Decode(TOKEN_PROGRAM_ID), base58Decode(USDC_MINT)];
  const a = findProgramAddress(seeds, ATA_PROGRAM_ID);
  assert.deepEqual(findProgramAddress(seeds, ATA_PROGRAM_ID), a);
  assert.equal(isOnCurve(base58Decode(a.address)), false);
  assert.ok(a.bump >= 0 && a.bump <= 255);
  // Recompute by hand: sha256(seeds || bump || programId || "ProgramDerivedAddress")
  const h = createHash("sha256");
  for (const s of seeds) h.update(s);
  h.update(Uint8Array.of(a.bump));
  h.update(base58Decode(ATA_PROGRAM_ID));
  h.update("ProgramDerivedAddress");
  assert.equal(base58Encode(new Uint8Array(h.digest())), a.address);
  // Every higher bump that was skipped produced an on-curve hash.
  for (let bump = 255; bump > a.bump; bump--) {
    const g = createHash("sha256");
    for (const s of seeds) g.update(s);
    g.update(Uint8Array.of(bump));
    g.update(base58Decode(ATA_PROGRAM_ID));
    g.update("ProgramDerivedAddress");
    assert.equal(isOnCurve(new Uint8Array(g.digest())), true);
  }
});

test("ATA derivation: depends on owner, mint and token program, and nothing else", () => {
  const w = addr(11);
  const base = deriveAta(w, USDC_MINT);
  assert.equal(deriveAta(w, USDC_MINT, TOKEN_PROGRAM_ID), base);
  assert.notEqual(deriveAta(w, USDC_MINT, TOKEN_2022_PROGRAM_ID), base);
  assert.notEqual(deriveAta(addr(12), USDC_MINT), base);
  assert.notEqual(deriveAta(w, addr(40)), base);
  assert.equal(base58Decode(base).length, 32);
  assert.equal(isOnCurve(base58Decode(base)), false);
  const seen = new Set<string>();
  for (let i = 0; i < 60; i++) seen.add(deriveAta(w, addr(30 + i)));
  assert.equal(seen.size, 60);
});

test("the frozen engine v1 files are untouched (compare relies on them to show the old behaviour)", () => {
  const sha = (f: string) => createHash("sha256").update(readFileSync(new URL(f, import.meta.url))).digest("hex").slice(0, 16);
  // If you must change these on purpose, update the digests AND say so in the commit: the "before" column of `compare` changes.
  assert.equal(sha("../../src/smart-money/ledger/legacy/rentV1.ts"), RENT_V1_DIGEST);
  assert.equal(sha("../../src/smart-money/ledger/legacy/buildV1.ts"), BUILD_V1_DIGEST);
});
const RENT_V1_DIGEST = "2b3ed061fe03a7ec";
const BUILD_V1_DIGEST = "8a7aaa92e48df8fc";
