import { test } from "node:test";
import assert from "node:assert/strict";
import { ONCHAIN_CONFIG } from "../src/onchain/config.ts";
import { HISTORY_CONFIG } from "../src/history/config.ts";
import { PublicRpcHistoryProvider } from "../src/history/publicRpc.ts";
import { WalletHistoryService } from "../src/history/service.ts";
import { checkFunders } from "../src/wallets/collect.ts";
import type { WalletRpc } from "../src/wallets/collect.ts";
import { WALLET_CONFIG } from "../src/wallets/config.ts";
import { buildIntel } from "../src/wallets/intel.ts";
import { qv } from "./helpers/quality.ts";
import type { Buyer } from "../src/wallets/intel.ts";
import { classifyCreatorLink, profileWallet } from "../src/wallets/profile.ts";
import type { CreatorFunding, ProfileContext } from "../src/wallets/profile.ts";
import { WalletIntelService } from "../src/wallets/service.ts";
import type { Trade } from "../src/wallets/trades.ts";
import type { TokenScan, WalletFacts } from "../src/wallets/types.ts";
import { CREATOR, dex, key, ptx, row, SYSTEM, T0, W, world } from "./helpers/world.ts";

const { busyFunderSignatures: BUSY, closeCreationMinutes: CLOSE } = ONCHAIN_CONFIG.clusters;
const FUNDER = key(120);
const WALLET = key(121);
const MINUTE = 60_000;
const t = (m: number) => T0 * 1000 + m * MINUTE;
/** One closed, evaluable position: Quality stays measured, so penalties are visible as numbers (B2). */
const ONE: Trade[] = [
  { signature: "one-buy", slot: null, time: t(-2000), owner: WALLET, mint: key(122), side: "buy", tokenAmount: 1000, sol: 1 },
  { signature: "one-sell", slot: null, time: t(-1990), owner: WALLET, mint: key(122), side: "sell", tokenAmount: 1000, sol: 1.5 },
];

const facts = (o: Partial<WalletFacts> = {}): WalletFacts => ({
  address: WALLET,
  signatureCount: 20,
  historyComplete: true,
  firstSeen: t(-3000),
  funder: FUNDER,
  fundingSignature: "wallet-funding",
  fundingTime: t(-3000),
  funderSignatureCount: null,
  signatures: [],
  trades: ONE,
  historyNote: "historique complet",
  undecodableTxs: 0,
  ...o,
});
const funding = (o: Partial<CreatorFunding> = {}): CreatorFunding => ({ signature: "creator-funding", time: t(-3002), funderSignatureCount: 40, ...o });
const ctx = (o: Partial<ProfileContext> = {}): ProfileContext => ({ creator: CREATOR, creatorFunder: FUNDER, creatorFunding: funding(), launchTime: t(0), relatedTo: [], launchTimes: {}, pricesSol: {}, now: t(600), ...o });
const creatorFlag = (p: ReturnType<typeof profileWallet>) => p.flags.find((f) => f.key === "sameFunderAsCreator" || f.key === "fundedByCreator") ?? null;
/** Quality of the same facts with no deployment-wallet information at all. */
const baseline = (f: WalletFacts) => profileWallet(f, ctx({ creatorFunder: null, creatorFunding: null }), null);

// ─── A–G: evidence → existing severities ─────────────────────────────────

test("A: funded directly by the deployment wallet → strong, HIGH (unchanged)", () => {
  const p = profileWallet(facts({ funder: CREATOR }), ctx(), null);
  assert.equal(p.creatorLink?.type, "fundedByCreator");
  assert.equal(p.creatorLink?.strength, "strong");
  assert.equal(creatorFlag(p)?.key, "fundedByCreator");
  assert.equal(creatorFlag(p)?.severity, "high");
});

test("B: same funding transaction → strong, HIGH, even with a busy funder", () => {
  const p = profileWallet(facts({ fundingSignature: "shared-funding" }), ctx({ creatorFunding: funding({ signature: "shared-funding", funderSignatureCount: BUSY }) }), null);
  assert.equal(p.creatorLink?.type, "sameFundingTx");
  assert.equal(p.creatorLink?.strength, "strong");
  assert.equal(creatorFlag(p)?.severity, "high");
});

test("C: same funder verified NOT busy, funded within the relationship window → strong, HIGH", () => {
  const p = profileWallet(facts({ fundingTime: t(-3000) }), ctx({ creatorFunding: funding({ time: t(-3000 - CLOSE + 1), funderSignatureCount: BUSY - 1 }) }), null);
  assert.equal(p.creatorLink?.type, "sameFunderClose");
  assert.equal(p.creatorLink?.strength, "strong");
  assert.equal(creatorFlag(p)?.severity, "high");
  assert.equal(qv(p.quality), Math.max(0, qv(baseline(p.facts).quality) - WALLET_CONFIG.quality.penalties.high));
});

test("D: same funder verified NOT busy, funded at different times → medium, not HIGH", () => {
  const p = profileWallet(facts({ fundingTime: t(-3000) }), ctx({ creatorFunding: funding({ time: t(-3000 - CLOSE - 1) }) }), null);
  assert.equal(p.creatorLink?.type, "sameFunder");
  assert.equal(p.creatorLink?.strength, "medium");
  assert.equal(creatorFlag(p)?.severity, "medium");
  assert.ok(!p.flags.some((f) => f.severity === "high"));
});

test("E: same BUSY funder → weak, descriptive only: no flag, no penalty", () => {
  for (const count of [BUSY, BUSY * 5]) {
    const p = profileWallet(facts(), ctx({ creatorFunding: funding({ funderSignatureCount: count }) }), null);
    assert.equal(p.creatorLink?.type, "sameBusyFunder");
    assert.equal(p.creatorLink?.strength, "weak");
    assert.equal(creatorFlag(p), null);
    assert.equal(qv(p.quality), qv(baseline(p.facts).quality), "no -25 (nor any other) penalty");
    assert.ok(p.unknowns.some((u) => u.includes("relation faible") && u.includes("non pénalisé")));
  }
});

test("F / unknown safety: funder activity UNKNOWN → never presumed rare, never strong, no flag", () => {
  // Even funded in the same minute: without a counted activity it stays insufficient evidence.
  for (const c of [ctx({ creatorFunding: funding({ funderSignatureCount: null, time: t(-3000) }) }), ctx({ creatorFunding: null })]) {
    const link = classifyCreatorLink(facts(), c);
    assert.equal(link?.type, "sameFunderUnknownActivity");
    assert.equal(link?.strength, "unknown");
    const p = profileWallet(facts(), c, null);
    assert.equal(creatorFlag(p), null);
    assert.equal(qv(p.quality), qv(baseline(p.facts).quality));
    assert.ok(p.unknowns.some((u) => u.includes("activité du financeur inconnue")));
  }
  // The wallet-side count describes the same funder: when it is counted, it is used.
  assert.equal(classifyCreatorLink(facts({ funderSignatureCount: BUSY }), ctx({ creatorFunding: funding({ funderSignatureCount: null }) }))?.strength, "weak");
});

test("G: funder UNKNOWN on either side → no link, no flag", () => {
  for (const [f, c] of [
    [facts({ funder: null, fundingSignature: null, fundingTime: null }), ctx()],
    [facts(), ctx({ creatorFunder: null, creatorFunding: null })],
  ] as const) {
    const p = profileWallet(f, c, null);
    assert.equal(p.creatorLink, null);
    assert.equal(creatorFlag(p), null);
  }
});

// ─── H–J: activity of the deployment wallet's funder, one check at most ──

function countingRpc(sigsPerFunder: Record<string, number>) {
  const calls: string[] = [];
  const rpc: WalletRpc = {
    url: "offline",
    async getSignatures(address: string) {
      calls.push(address);
      return Array.from({ length: sigsPerFunder[address] ?? 0 }, (_, i) => ({ signature: `${address}-${i}`, slot: i, blockTime: T0, err: null }));
    },
    async getTransaction() {
      return null;
    },
  };
  return { rpc, calls };
}
const wf = (n: number, funder: string | null): WalletFacts => ({ ...facts(), address: key(130 + n), funder });

test("H: creator funder already among the shared funders → checked once, result reused", async () => {
  const { rpc, calls } = countingRpc({ [FUNDER]: 1000 });
  const fs = [wf(0, FUNDER), wf(1, FUNDER), wf(2, key(140))];
  const counts = await checkFunders(rpc, fs, undefined, { alsoCheck: FUNDER });
  assert.deepEqual(calls, [FUNDER]);
  assert.equal(counts.get(FUNDER), 1000);
});

test("I: no analysed wallet shares the creator funder → no extra check", async () => {
  const { rpc, calls } = countingRpc({});
  await checkFunders(rpc, [wf(0, key(140)), wf(1, key(141)), wf(2, null)], undefined, { alsoCheck: FUNDER });
  assert.deepEqual(calls, []);
});

test("J: one or many wallets share the creator funder → exactly one check for it", async () => {
  for (const n of [1, 5]) {
    const { rpc, calls } = countingRpc({ [FUNDER]: 12 });
    const fs = Array.from({ length: n }, (_, i) => wf(i, FUNDER));
    const counts = await checkFunders(rpc, fs, undefined, { alsoCheck: FUNDER });
    assert.deepEqual(calls, [FUNDER]);
    assert.equal(counts.get(FUNDER), 12);
    assert.ok(fs.every((f) => f.funderSignatureCount === 12));
  }
});

test("H–J through WalletIntelService: the creator funder is checked once, from facts already fetched, and decides the link", async () => {
  for (const busy of [false, true]) {
    const w = world();
    // The deployment wallet was funded by W0's funder (key(40)), three days before W0.
    const cfund = ptx("creator-funding", 0, T0 - 3 * 86_400, key(40), { [key(40)]: -1e9, [CREATOR]: 1e9 }, [], SYSTEM);
    const funderCalls: string[] = [];
    const rpc: WalletRpc = {
      url: "offline",
      async getSignatures(a: string, limit: number, before?: string) {
        if (a === CREATOR) return before ? [] : [{ signature: "creator-funding", slot: 0, blockTime: cfund.blockTime, err: null }];
        if (a === key(40)) {
          funderCalls.push(a);
          return Array.from({ length: busy ? BUSY : 3 }, (_, i) => ({ signature: `k40-${i}`, slot: i, blockTime: T0, err: null }));
        }
        return w.rpc.getSignatures(a, limit, before);
      },
      async getTransaction(s: string) {
        return s === "creator-funding" ? cfund : w.rpc.getTransaction(s);
      },
    };
    const intel = await new WalletIntelService(rpc, dex, WALLET_CONFIG, { history: ({ rpc: g }) => new WalletHistoryService({ providers: [new PublicRpcHistoryProvider(g, HISTORY_CONFIG.publicRpc)] }) }).analyze(row, w.onchain);
    assert.deepEqual(funderCalls, [key(40)], "one activity check for the creator funder");
    const w0 = intel.tracked.find((x) => x.address === W[0])!.profile;
    assert.equal(w0.creatorLink?.type, busy ? "sameBusyFunder" : "sameFunder");
    assert.equal(creatorFlag(w0)?.severity ?? null, busy ? null : "medium");
    assert.ok(intel.tracked.filter((x) => x.address !== W[0]).every((x) => x.profile.creatorLink === null));
  }
});

// ─── K: clusters ─────────────────────────────────────────────────────────

const scan: TokenScan = { mint: key(1), launch: { time: t(0), slot: 1, signature: "launch" }, signaturesScanned: 10, launchReachable: true, transactionsFetched: 10, transactionsFailed: 0, undecodable: 0, earlyTrades: [], recentTrades: [], supply: 1_000_000_000, solUsd: null };
const buyer = (a: string, i: number): Buyer => ({ address: a, firstBuy: { signature: `b${i}`, slot: 2, time: t(i), owner: a, mint: key(1), side: "buy", tokenAmount: 1, sol: 1 }, entryMinutesAfterLaunch: i, sameSlotAsLaunch: false, entryMcapSol: null, entryMcapUsdEst: null, buys: 1, solSpent: 1, sells: 0, solReceived: 0, currentPct: null });

test("K / DON regression: a busy funder shared with the deployment wallet forms no cluster; sameBusyFunder stays weak, sharedTx stays strong", () => {
  const a = key(150), b = key(151), c = key(152), d = key(153);
  const fs: WalletFacts[] = [
    { ...facts(), address: a, funder: FUNDER, funderSignatureCount: BUSY, fundingSignature: "fa", firstSeen: t(-5000), fundingTime: t(-5000) },
    { ...facts(), address: b, funder: FUNDER, funderSignatureCount: BUSY, fundingSignature: "fb", firstSeen: t(-3000), fundingTime: t(-3000) },
    { ...facts(), address: c, funder: key(160), fundingSignature: "fc", signatures: ["shared"], firstSeen: t(-9000), fundingTime: t(-9000) },
    { ...facts(), address: d, funder: key(161), fundingSignature: "fd", signatures: ["shared"], firstSeen: t(-7000), fundingTime: t(-7000) },
  ];
  const intel = buildIntel(scan, [a, b, c, d].map(buyer), fs, { creator: CREATOR, creatorFunder: FUNDER, creatorFunding: funding({ funderSignatureCount: BUSY, time: t(-3001) }), holdersPct: null, excluded: () => false, launchTimes: {}, pricesSol: {}, now: t(600) });
  const busyLink = intel.related.links.find((l) => l.type === "sameBusyFunder");
  assert.equal(busyLink?.strength, "weak");
  assert.equal(intel.related.links.find((l) => l.type === "sharedTx")?.strength, "strong");
  assert.equal(intel.related.groups.length, 1, "only the sharedTx pair is grouped");
  assert.deepEqual(intel.related.groups[0].members.map((m) => m.address).sort(), [c, d].sort());
  assert.equal(intel.independentClusters, 3, "a and b stay independent");
  for (const x of [a, b]) {
    const p = intel.tracked.find((y) => y.address === x)!.profile;
    assert.equal(p.creatorLink?.strength, "weak", "busy even within the time window: never strong");
    assert.equal(creatorFlag(p), null);
  }
});

// ─── L: Confidence ───────────────────────────────────────────────────────

test("L: Confidence is no longer capped by a false HIGH (busy / unknown); a real strong link still caps it", () => {
  const trades: Trade[] = Array.from({ length: 30 }, (_, i) => [
    { signature: `b${i}`, slot: null, time: t(-2000 + i * 10), owner: WALLET, mint: key(170 + (i % 80)), side: "buy" as const, tokenAmount: 100, sol: 1 },
    { signature: `s${i}`, slot: null, time: t(-2000 + i * 10 + 5), owner: WALLET, mint: key(170 + (i % 80)), side: "sell" as const, tokenAmount: 100, sol: 1.5 },
  ]).flat();
  const f = facts({ trades, signatureCount: 61 });
  assert.equal(baseline(f).confidence, "HIGH");
  assert.equal(profileWallet(f, ctx({ creatorFunding: funding({ funderSignatureCount: BUSY }) }), null).confidence, "HIGH", "busy funder");
  assert.equal(profileWallet(f, ctx({ creatorFunding: funding({ funderSignatureCount: null }) }), null).confidence, "HIGH", "unknown activity");
  assert.equal(profileWallet(f, ctx({ creatorFunding: funding({ time: f.fundingTime }) }), null).confidence, "MEDIUM", "strong link (non-busy, same minute) still caps HIGH");
});

// ─── BUBBLE regression ───────────────────────────────────────────────────

test("BUBBLE regression: FHw4-like wallet sharing a busy funder with the deployment wallet gets no HIGH, no -25, no strong link, no cluster, same metrics", () => {
  // Complete history: bought then sold one token; funded 16.5 h before entry by a busy funder shared with the deployment wallet.
  const fhw4: WalletFacts = facts({
    address: key(180),
    funder: key(181),
    funderSignatureCount: null,
    fundingSignature: "fhw4-funding",
    firstSeen: t(-990),
    fundingTime: t(-990),
    trades: [
      { signature: "fb", slot: null, time: t(0), owner: key(180), mint: key(1), side: "buy", tokenAmount: 1000, sol: 4.77 },
      { signature: "fs", slot: null, time: t(3), owner: key(180), mint: key(1), side: "sell", tokenAmount: 1000, sol: 24.85 },
    ],
  });
  const busyCreator = ctx({ creatorFunder: key(181), creatorFunding: funding({ signature: "creator-funding", time: t(-2000), funderSignatureCount: BUSY }) });
  const p = profileWallet(fhw4, busyCreator, t(0));
  const none = profileWallet(fhw4, ctx({ creatorFunder: null, creatorFunding: null }), t(0));
  assert.ok(!p.flags.some((f) => f.key === "sameFunderAsCreator"));
  assert.ok(!p.flags.some((f) => f.severity === "high"));
  assert.equal(p.creatorLink?.strength, "weak");
  assert.equal(qv(p.quality), qv(none.quality), "no -25 from the shared busy funder");
  assert.deepEqual(p.metrics, none.metrics, "history / PnL untouched");
  const intel = buildIntel(scan, [buyer(key(180), 0)], [fhw4], { creator: CREATOR, creatorFunder: key(181), creatorFunding: busyCreator.creatorFunding, holdersPct: null, excluded: () => false, launchTimes: {}, pricesSol: {}, now: t(600) });
  assert.equal(intel.related.groups.length, 0);
  assert.equal(intel.independentClusters, 1);
});
