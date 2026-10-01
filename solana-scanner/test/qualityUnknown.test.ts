import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base58Encode } from "../src/onchain/base58.ts";
import { buildIntel } from "../src/wallets/intel.ts";
import type { Buyer } from "../src/wallets/intel.ts";
import { formatQuality, presentFlags, profileWallet } from "../src/wallets/profile.ts";
import type { ProfileContext, WalletProfile } from "../src/wallets/profile.ts";
import { addFailure, unknownWalletFacts } from "../src/wallets/resilience.ts";
import type { Trade } from "../src/wallets/trades.ts";
import type { TokenScan, WalletFacts } from "../src/wallets/types.ts";
import { WALLET_CONFIG } from "../src/wallets/config.ts";
import { qv } from "./helpers/quality.ts";

/**
 * Wallet Quality UNKNOWN: a number only when the history is complete
 * (facts.trades !== null), otherwise UNKNOWN with a recorded reason. Flags are
 * kept as observations; measured scores, Confidence and clusters unchanged.
 */

const key = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const W = key(10);
const CREATOR = key(90);
const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);
const min = (m: number) => T0 + m * 60_000;

const trade = (mint: string, side: "buy" | "sell", sol: number, t: number): Trade => ({ signature: `${mint}-${side}-${t}`, slot: null, time: t, owner: W, mint, side, tokenAmount: 1000, sol });
const closedTrades = (n: number, solIn: number, solOut: number, start = min(-2000)) =>
  Array.from({ length: n }, (_, i) => [trade(key(100 + i), "buy", solIn, start + i * 60_000), trade(key(100 + i), "sell", solOut, start + i * 60_000 + 30_000)]).flat();

const quietBot = { sampleSize: 60, spanMinutes: 20, txPerMinute: 0.1, trades: 4, distinctTokens: 4, roundTrips: 0, fastRoundTrips: 0, identicalAmountRoundTrips: 0, medianHoldSeconds: null, averageTicketSol: 1, highFrequency: false, fastFlipper: false, manyTokens: false, microTickets: false, botLike: false, evidence: [] as string[] };
const busyBot = { ...quietBot, txPerMinute: 3, trades: 24, distinctTokens: 12, roundTrips: 12, fastRoundTrips: 12, highFrequency: true, fastFlipper: true, manyTokens: true, botLike: true, evidence: ["3.0 transactions/min sur 20 min"] };
const history = (o: { originSignature?: string | null; bot?: typeof quietBot; incomplete?: boolean } = {}): any => ({
  mode: "quick",
  completeness: o.incomplete ? "partial" : "recent_page_covers_history",
  signatureCountIsLowerBound: !!o.incomplete,
  origin: { found: true, firstSeen: null, signature: o.originSignature ?? null, method: "recent_page", complete: !o.incomplete, reason: "found", signaturesScanned: 0, totalSignatures: null },
  bot: o.bot ?? quietBot,
  transfers: [],
  quickCompletion: o.incomplete ? { attempted: false, skippedReason: "history_too_long", stopReason: null, pages: 0 } : { attempted: false, skippedReason: "complete_from_quick", stopReason: null, pages: 0 },
  deep: o.incomplete ? { attempted: false, skippedReason: "deep_disabled", stopReason: null } : { attempted: false, skippedReason: "complete_from_quick", stopReason: null },
  providerTrace: [],
  unknowns: [],
});
const facts = (o: Partial<WalletFacts> = {}): WalletFacts => ({
  address: W, signatureCount: 40, historyComplete: true, firstSeen: min(-30 * 24 * 60), funder: key(50), fundingSignature: "old-funding", fundingTime: min(-30 * 24 * 60),
  funderSignatureCount: null, signatures: [], trades: closedTrades(4, 1, 1.5), historyNote: "historique complet", undecodableTxs: 0, history: history({ originSignature: "old-funding" }), ...o,
});
/** History too long for QUICK, completion skipped, DEEP disabled (the D12R / 7sZa shape). */
const incomplete = (o: Partial<WalletFacts> = {}, bot = quietBot): WalletFacts =>
  facts({ signatureCount: 1000, historyComplete: false, trades: null, historyNote: "≥ 1,000 transactions : historique partiel", history: history({ originSignature: "old-funding", incomplete: true, bot }), ...o });
const ctx = (o: Partial<ProfileContext> = {}): ProfileContext => ({ creator: CREATOR, creatorFunder: null, creatorFunding: null, launchTime: min(0), relatedTo: [], launchTimes: {}, pricesSol: {}, now: min(600), ...o });

const scan: TokenScan = { mint: key(1), launch: { time: min(0), slot: 1, signature: "launch" }, signaturesScanned: 10, launchReachable: true, transactionsFetched: 10, transactionsFailed: 0, undecodable: 0, earlyTrades: [], recentTrades: [], supply: 1_000_000_000, solUsd: null };
const buyer = (a: string, i: number): Buyer => ({ address: a, firstBuy: { signature: `b${i}`, slot: 2, time: min(10 + i), owner: a, mint: key(1), side: "buy", tokenAmount: 1, sol: 1 }, entryMinutesAfterLaunch: 10 + i, sameSlotAsLaunch: false, entryMcapSol: null, entryMcapUsdEst: null, buys: 1, solSpent: 1, sells: 0, solReceived: 0, currentPct: null });
const intel = (fs: WalletFacts[], c: Partial<ProfileContext> = {}) =>
  buildIntel(scan, fs.map((f, i) => buyer(f.address, i)), fs, { creator: CREATOR, creatorFunder: c.creatorFunder ?? null, creatorFunding: c.creatorFunding ?? null, holdersPct: null, excluded: () => false, launchTimes: {}, pricesSol: {}, now: min(600) });

/** A wallet that clears the high-quality bar (30 closed positions, complete history). */
const strong = (address: string): WalletFacts => {
  const trades: Trade[] = [];
  for (let i = 0; i < 30; i++) {
    const m = key(100 + i);
    const t = min(-3000 + i * 60);
    trades.push({ ...trade(m, "buy", 1, t), owner: address }, { ...trade(m, "sell", i % 3 === 0 ? 0.8 : 1.6, t + 30 * 60_000), owner: address });
  }
  return facts({ address, signatureCount: 70, trades, funder: key(51), fundingSignature: `fund-${address}` });
};
const penaltyItem = (p: WalletProfile) => p.qualityItems.find((i) => i.label.startsWith("Pénalités (motifs suspects)"));

// ─── measured boundary ───────────────────────────────────────────────────

test("A: Q0 truly measured — complete empty history (raw 20) − fundedByCreator 25 → measured 0", () => {
  const p = profileWallet(facts({ trades: [], funder: CREATOR }), ctx(), min(1));
  assert.deepEqual(p.quality, { status: "measured", value: 0 });
  assert.equal(penaltyItem(p)?.points, -WALLET_CONFIG.quality.penalties.high);
  assert.equal(formatQuality(p.quality), "0");
});

test("B: complete history with no evaluable position → measured, current value (raw 20 kept, not fixed here)", () => {
  // One open position whose current price is unknown: nothing evaluable.
  const p = profileWallet(facts({ trades: [trade(key(100), "buy", 1, min(-100))] }), ctx(), min(1));
  assert.equal(p.metrics!.evaluated, 0);
  assert.deepEqual(p.quality, { status: "measured", value: 20 });
});

test("C: complete history with no transaction → measured 20", () => {
  const p = profileWallet(facts({ trades: [], signatureCount: 0 }), ctx(), min(1));
  assert.deepEqual(p.quality, { status: "measured", value: 20 });
  assert.equal(p.confidence, "LOW");
});

// ─── unknown boundary ────────────────────────────────────────────────────

test("D: incomplete history → UNKNOWN history_incomplete with its recorded details, never 0", () => {
  const p = profileWallet(incomplete(), ctx(), min(1));
  assert.deepEqual(p.quality, { status: "unknown", reason: { code: "history_incomplete", details: ["history_too_long", "deep_disabled"] } });
  assert.equal(p.confidence, "LOW");
  assert.equal(p.metrics, null);
  assert.equal(formatQuality(p.quality), "UNKNOWN (history_incomplete: history_too_long, deep_disabled)");
  assert.ok(!p.qualityItems.some((i) => i.points !== 0), "no score item, no implicit 0/100");
  // No history-layer record at all: the reason is still history_incomplete, with no invented detail.
  const bare = profileWallet(incomplete({ history: undefined }), ctx(), min(1));
  assert.deepEqual(bare.quality, { status: "unknown", reason: { code: "history_incomplete", details: [] } });
});

test("E: all sources fail → UNKNOWN provider_failure (kind kept); circuit open → skipped", () => {
  const failed = profileWallet(unknownWalletFacts(W, "history", "quota_exhausted", false), ctx(), min(1));
  assert.deepEqual(failed.quality, { status: "unknown", reason: { code: "provider_failure", kind: "quota_exhausted" } });
  assert.equal(formatQuality(failed.quality), "UNKNOWN (provider_failure: quota_exhausted)");
  const skipped = profileWallet(unknownWalletFacts(W, "history", "timeout", true), ctx(), min(1));
  assert.deepEqual(skipped.quality, { status: "unknown", reason: { code: "skipped", kind: "timeout" } });
  assert.equal(failed.confidence, "LOW");
});

test("F: successful fallback → measured, same value as the same facts without the failure record", () => {
  const clean = facts();
  const withFailure = facts();
  addFailure(withFailure, "funder_check", "rate_limited");
  const a = profileWallet(withFailure, ctx(), min(1));
  const b = profileWallet(clean, ctx(), min(1));
  assert.equal(a.quality.status, "measured");
  assert.deepEqual(a.quality, b.quality);
  // A failure outside the history read never becomes the reason of an UNKNOWN score.
  const inc = incomplete();
  addFailure(inc, "funder_check", "rate_limited");
  const p = profileWallet(inc, ctx(), min(1));
  assert.equal(p.quality.status === "unknown" && p.quality.reason.code, "history_incomplete");
});

// ─── flags on UNKNOWN wallets: observations ──────────────────────────────

test("G: UNKNOWN + creatorLink HIGH → flag kept as an observation, no points removed", () => {
  const p = profileWallet(incomplete({ funder: CREATOR }), ctx(), min(1));
  assert.equal(p.creatorLink?.type, "fundedByCreator");
  const fl = p.flags.find((x) => x.key === "fundedByCreator")!;
  assert.equal(fl.severity, "high");
  assert.equal(p.quality.status, "unknown");
  assert.equal(penaltyItem(p), undefined);
  const pf = presentFlags(p);
  assert.deepEqual(pf.penalised, []);
  assert.ok(pf.notPenalised.some((x) => x.key === "fundedByCreator"));
});

test("H: UNKNOWN + related → flag and cluster kept", () => {
  const fs = [key(20), key(21)].map((a) => incomplete({ address: a, signatures: ["bundle"] }));
  const out = intel(fs);
  assert.ok(out.related.links.some((l) => l.type === "sharedTx"));
  assert.equal(out.related.groups.length, 1);
  assert.equal(out.independentClusters, 1);
  for (const t of out.tracked) {
    assert.ok(t.profile.flags.some((x) => x.key === "related"));
    assert.equal(t.profile.quality.status, "unknown");
  }
});

test("I: UNKNOWN + botLike → busy kept", () => {
  const p = profileWallet(incomplete({}, busyBot), ctx(), min(1));
  const busy = p.flags.find((x) => x.key === "busy")!;
  assert.equal(busy.severity, "medium");
  assert.ok(busy.detail.includes("transactions/min"));
  assert.equal(p.quality.status, "unknown");
  assert.equal(p.confidence, "LOW");
});

test("J: penaltyApplied / suppressedBy kept on UNKNOWN, no fictitious penalty item", () => {
  // fresh + fundedBeforeLaunch from the same first transaction.
  const p = profileWallet(incomplete({ firstSeen: min(-30), fundingTime: min(-30), fundingSignature: "first-tx", history: history({ originSignature: "first-tx", incomplete: true }) }), ctx(), min(1));
  const fresh = p.flags.find((x) => x.key === "fresh")!;
  const fbl = p.flags.find((x) => x.key === "fundedBeforeLaunch")!;
  assert.equal(fresh.penaltyApplied, false);
  assert.equal(fresh.suppressedBy, "fundedBeforeLaunch");
  assert.equal(fbl.penaltyApplied, true);
  assert.equal(penaltyItem(p), undefined);
  assert.ok(!p.qualityItems.some((i) => i.label.startsWith("Pénalités neutralisées")));
  const inc = p.flags.find((x) => x.key === "incomplete")!;
  assert.deepEqual([inc.group, inc.penaltyApplied, inc.suppressedBy], ["data", false, null]);
});

// ─── counters ────────────────────────────────────────────────────────────

const mix = () => [strong(key(30)), facts({ address: key(31), funder: key(52), fundingSignature: "fund-31" }), incomplete({ address: key(32), funder: key(53), fundingSignature: "fund-32" }), unknownWalletFacts(key(33), "history", "timeout", false), unknownWalletFacts(key(34), "history", "network", true)];

test("K: highQuality unchanged — only measured wallets can count, UNKNOWN never does", () => {
  const all = intel(mix());
  const measuredOnly = intel(mix().slice(0, 2));
  assert.equal(all.highQuality, 1);
  assert.equal(all.highQuality, measuredOnly.highQuality);
});

test("L: independentClusters unchanged — UNKNOWN wallets stay in the totals and in their clusters", () => {
  const out = intel(mix());
  assert.equal(out.tracked.length, 5);
  assert.equal(out.independentClusters, 5);
  assert.equal(out.historiesReconstructed, 2);
});

test("M: measured / unknown counters with a breakdown by reason", () => {
  const out = intel(mix());
  assert.equal(out.measured, 2);
  assert.equal(out.unknown, 3);
  assert.deepEqual(out.unknownByReason, { history_incomplete: 1, provider_failure: 1, skipped: 1 });
  assert.equal(out.measured + out.unknown, out.tracked.length);
});

test("N: JSON — no implicit 0, no NaN, no null quality; round-trips", () => {
  const out = intel(mix());
  const json = JSON.stringify(out.tracked.map((t) => ({ address: t.address, quality: t.profile.quality })));
  assert.ok(!json.includes("NaN"));
  const back = JSON.parse(json) as { address: string; quality: unknown }[];
  for (const [i, t] of out.tracked.entries()) {
    assert.deepEqual(back[i].quality, t.profile.quality);
    if (t.profile.quality.status === "unknown") assert.ok(!("value" in t.profile.quality), "UNKNOWN carries no number");
    else assert.ok(Number.isFinite(t.profile.quality.value));
  }
  for (const t of out.tracked) assert.ok(!formatQuality(t.profile.quality).match(/object|null|NaN|undefined/));
});

// ─── UI presentation ─────────────────────────────────────────────────────

test("O: UI — UNKNOWN shown with its reason, incomplete outside suspicious patterns", () => {
  const p = profileWallet(incomplete({ funder: CREATOR }, busyBot), ctx(), min(1));
  const pf = presentFlags(p);
  assert.deepEqual(pf.dataStatus.map((x) => x.key), ["incomplete"]);
  assert.ok(![...pf.penalised, ...pf.notPenalised].some((x) => x.key === "incomplete"));
  assert.deepEqual(pf.penalised, [], "UNKNOWN: no flag presented as a removed penalty");
  assert.deepEqual(pf.notPenalised.map((x) => x.key).sort(), ["busy", "fundedByCreator"]);
  // Measured: applied and neutralised penalties keep their split.
  const m = profileWallet(facts({ firstSeen: min(-30), fundingTime: min(-30), fundingSignature: "first-tx", history: history({ originSignature: "first-tx" }) }), ctx(), min(1));
  const pm = presentFlags(m);
  assert.deepEqual(pm.penalised.map((x) => x.key), ["fundedBeforeLaunch"]);
  assert.deepEqual(pm.notPenalised.map((x) => x.key), ["fresh"]);
  // The panel renders through these helpers, never the raw object.
  const src = readFileSync(new URL("../src/ui/WalletPanel.tsx", import.meta.url), "utf8");
  assert.ok(src.includes("presentFlags(p)") && src.includes("formatQuality(p.quality)"));
  assert.ok(src.includes('t.profile.quality.status === "measured" ? t.profile.quality.value : "UNKNOWN"'));
  assert.ok(!/\{p\.quality\}|\{t\.profile\.quality\}/.test(src));
});

// ─── regressions (shapes of the live wallets) ────────────────────────────

test("P: BUBBLE / DON / DOGRILLA regressions", () => {
  // BUBBLE FHw4-like: complete reconstructed history, shared busy funder → measured, no -25.
  const fhw4 = facts({ trades: [trade(key(1), "buy", 4.77, min(0)), trade(key(1), "sell", 24.85, min(3))], funder: key(181) });
  const busyCreator = ctx({ creatorFunder: key(181), creatorFunding: { signature: "creator-funding", time: min(-2000), funderSignatureCount: 5000 } });
  const bubble = profileWallet(fhw4, busyCreator, min(0));
  assert.equal(bubble.quality.status, "measured");
  assert.equal(qv(bubble.quality), qv(profileWallet(fhw4, ctx(), min(0)).quality));
  // DON BCByJu-like: complete long history → measured high quality, HIGH confidence.
  const bc = profileWallet(strong(W), ctx(), min(0));
  assert.ok(qv(bc.quality) >= WALLET_CONFIG.highQualityThreshold);
  assert.equal(bc.confidence, "HIGH");
  // DON 7sZa / 3TQB-like: incomplete (history too long), linked by a shared transaction → UNKNOWN, still clustered.
  const don = intel([key(40), key(41)].map((a) => incomplete({ address: a, signatures: ["shared"] })));
  assert.equal(don.related.groups.length, 1);
  for (const t of don.tracked) {
    assert.deepEqual(t.profile.quality, { status: "unknown", reason: { code: "history_incomplete", details: ["history_too_long", "deep_disabled"] } });
    assert.equal(t.profile.confidence, "LOW");
  }
  // DOGRILLA D12R-like: history too long, bot-like → UNKNOWN, LOW, busy kept.
  const d12r = profileWallet(incomplete({}, busyBot), ctx(), min(1));
  assert.equal(formatQuality(d12r.quality), "UNKNOWN (history_incomplete: history_too_long, deep_disabled)");
  assert.equal(d12r.confidence, "LOW");
  assert.ok(d12r.flags.some((x) => x.key === "busy"));
});
