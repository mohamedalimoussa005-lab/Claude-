import { test } from "node:test";
import assert from "node:assert/strict";
import { base58Encode } from "../src/onchain/base58.ts";
import { findRelatedWallets } from "../src/onchain/clusters.ts";
import { ONCHAIN_CONFIG } from "../src/onchain/config.ts";
import type { WalletHistory } from "../src/onchain/types.ts";
import { buildIntel } from "../src/wallets/intel.ts";
import type { Buyer } from "../src/wallets/intel.ts";
import type { TokenScan, WalletFacts } from "../src/wallets/types.ts";

const key = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const { busyFunderSignatures: BUSY, closeCreationMinutes: CLOSE } = ONCHAIN_CONFIG.clusters;
const OPTS = { closeCreationMinutes: CLOSE, busyFunderSignatures: BUSY };
const FUNDER = key(99);
const A = key(10);
const B = key(11);
const T0 = 1_790_000_000_000;

/** Two wallets with the same funder, `gapMs` apart, funder activity `count` (null = not counted). */
const pair = (gapMs: number, count: number | null, o: { sameTx?: boolean; shared?: boolean } = {}): WalletHistory[] =>
  [A, B].map((address, i) => ({
    address,
    pct: 2,
    signatureCount: 5,
    historyComplete: true,
    firstSeen: T0 + i * gapMs,
    funder: FUNDER,
    fundingSignature: o.sameTx ? "same-funding" : `funding-${i}`,
    funderSignatureCount: count,
    signatures: [o.sameTx ? "same-funding" : `funding-${i}`, ...(o.shared ? ["bundle"] : []), `own-${i}`],
  }));
const run = (ws: WalletHistory[]) => findRelatedWallets(ws, OPTS);
const types = (r: ReturnType<typeof run>) => r.links.map((l) => `${l.type}/${l.strength}`).sort();

test("A: same funder counted NOT busy + close → sameFunderClose strong → one cluster", () => {
  const r = run(pair(5 * 60_000, BUSY - 1));
  assert.deepEqual(types(r), ["sameFunderClose/strong"]);
  assert.equal(r.groups.length, 1);
  assert.equal(r.strongLinks, 1);
});

test("B / C / D: busy funder 1 min, 1 s or the same second (different funding transactions) → sameBusyFunder weak, no cluster", () => {
  for (const gap of [60_000, 1_000, 0]) {
    const r = run(pair(gap, BUSY));
    assert.deepEqual(types(r), ["sameBusyFunder/weak"], `gap ${gap} ms`);
    assert.equal(r.groups.length, 0);
    assert.equal(r.strongLinks, 0);
    assert.match(r.links[0].reason, /proximité non probante/, "the proximity stays visible, descriptively");
  }
  // Just outside the window too.
  assert.deepEqual(types(run(pair((CLOSE + 1) * 60_000, BUSY))), ["sameBusyFunder/weak"]);
});

test("E: busy funder but the SAME funding transaction → sameTx strong → cluster", () => {
  const r = run(pair(0, BUSY, { sameTx: true }));
  assert.deepEqual(types(r), ["sameTx/strong"]);
  assert.equal(r.groups.length, 1);
});

test("F: funder activity UNKNOWN + close → not strong, no cluster", () => {
  for (const count of [null, undefined]) {
    const ws = pair(1_000, null).map((w) => (count === undefined ? (({ funderSignatureCount: _x, ...rest }) => rest)(w) : w)) as WalletHistory[];
    const r = run(ws);
    assert.deepEqual(types(r), ["sameFunderUnknownActivity/unknown"]);
    assert.equal(r.groups.length, 0);
    assert.equal(r.strongLinks, 0);
  }
});

test("G: funder activity UNKNOWN + distant → no merging medium link, no cluster", () => {
  const r = run(pair(3 * 86_400_000, null));
  assert.deepEqual(types(r), ["sameFunderUnknownActivity/unknown"]);
  assert.equal(r.groups.length, 0);
});

test("H: same funder counted NOT busy + distant → sameFunder medium, grouped as before", () => {
  const r = run(pair(3 * 86_400_000, 40));
  assert.deepEqual(types(r), ["sameFunder/medium"]);
  assert.equal(r.groups.length, 1);
});

test("I / DON regression (7sZa ↔ 3TQB): busy funder 1 s apart, different funding transactions, plus a shared transaction → sameBusyFunder weak, sharedTx strong, still one cluster", () => {
  const r = run(pair(1_000, BUSY, { shared: true }));
  assert.deepEqual(types(r), ["sameBusyFunder/weak", "sharedTx/strong"]);
  assert.ok(!r.links.some((l) => l.type === "sameFunderClose"));
  assert.equal(r.groups.length, 1);
  assert.deepEqual(r.groups[0].members.map((m) => m.address).sort(), [A, B].sort());
});

test("fundedBy stays strong and still merges", () => {
  const ws = pair(1_000, BUSY);
  ws[1] = { ...ws[1], funder: A };
  const r = run(ws);
  assert.ok(r.links.some((l) => l.type === "fundedBy" && l.strength === "strong"));
  assert.equal(r.groups.length, 1);
});

// ─── J / L: Step 4 ───────────────────────────────────────────────────────

const scan: TokenScan = { mint: key(1), launch: { time: T0, slot: 1, signature: "launch" }, signaturesScanned: 10, launchReachable: true, transactionsFetched: 10, transactionsFailed: 0, undecodable: 0, earlyTrades: [], recentTrades: [], supply: 1_000_000_000, solUsd: null };
const buyer = (a: string, i: number): Buyer => ({ address: a, firstBuy: { signature: `b${i}`, slot: 2, time: T0 + i, owner: a, mint: key(1), side: "buy", tokenAmount: 1, sol: 1 }, entryMinutesAfterLaunch: 0, sameSlotAsLaunch: false, entryMcapSol: null, entryMcapUsdEst: null, buys: 1, solSpent: 1, sells: 0, solReceived: 0, currentPct: null });
const facts = (h: WalletHistory): WalletFacts => ({ address: h.address, signatureCount: h.signatureCount, historyComplete: true, firstSeen: h.firstSeen, funder: h.funder, fundingSignature: h.fundingSignature, fundingTime: h.firstSeen, funderSignatureCount: h.funderSignatureCount ?? null, signatures: h.signatures, trades: [], historyNote: "complet", undecodableTxs: 0 });
const intelFor = (ws: WalletHistory[]) => buildIntel(scan, ws.map((w, i) => buyer(w.address, i)), ws.map(facts), { creator: key(200), creatorFunder: null, holdersPct: null, excluded: () => false, launchTimes: {}, pricesSol: {}, now: T0 + 86_400_000 });

test("J / L: busy close or unknown-activity close alone → no cluster, no related flag, no −12 in Step 4; a verified non-busy close still is", () => {
  for (const count of [BUSY, null]) {
    const intel = intelFor(pair(1_000, count));
    assert.equal(intel.related.groups.length, 0);
    assert.equal(intel.independentClusters, 2);
    for (const t of intel.tracked) assert.ok(!t.profile.flags.some((f) => f.key === "related"), `count ${count}`);
  }
  const real = intelFor(pair(1_000, 40));
  assert.equal(real.independentClusters, 1);
  assert.ok(real.tracked.every((t) => t.profile.flags.some((f) => f.key === "related")));
});
