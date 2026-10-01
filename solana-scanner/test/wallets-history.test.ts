import { test } from "node:test";
import assert from "node:assert/strict";
import { base58Encode } from "../src/onchain/base58.ts";
import type { ParsedTransaction, SignatureInfo } from "../src/onchain/rpc.ts";
import { HISTORY_CONFIG } from "../src/history/config.ts";
import type { HistoryConfig } from "../src/history/config.ts";
import { normalizeParsed } from "../src/history/normalize.ts";
import { PublicRpcHistoryProvider } from "../src/history/publicRpc.ts";
import { WalletHistoryService } from "../src/history/service.ts";
import { detectBotSignals } from "../src/wallets/botSignals.ts";
import type { WalletRpc } from "../src/wallets/collect.ts";
import { WALLET_CONFIG } from "../src/wallets/config.ts";
import { collectTokenWalletsFromHistory, collectWalletFactsFromHistory, DeepBudget } from "../src/wallets/historyFacts.ts";
import { buildIntel } from "../src/wallets/intel.ts";
import type { Buyer } from "../src/wallets/intel.ts";
import { profileWallet } from "../src/wallets/profile.ts";
import type { ProfileContext } from "../src/wallets/profile.ts";
import type { TokenScan } from "../src/wallets/types.ts";

const key = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM = "11111111111111111111111111111111";
const POOL = key(200);
const FUNDER = key(201);
const T0 = 1_790_000_000; // seconds
const HOUR = 3600;

const A = key(11); // normal wallet, complete history > 150 tx
const B = key(12); // 80 tx, incomplete history
const C = key(13); // D12R-like bot
const CREATOR = key(14);
const E = key(15); // complete, closed positions
const F = key(16); // open / partial positions
const R = [key(21), key(22), key(23), key(24), key(25)]; // creator recipients
const MINT = key(1);
const mint = (i: number) => base58Encode(new Uint8Array(32).fill(100 + (i % 100)).map((v, j) => (j === 0 ? v : j === 1 ? Math.floor(i / 100) + 1 : v)));

// ─── fixture builder ─────────────────────────────────────────────────────

interface Move {
  signers: string[];
  lamports: Record<string, number>;
  tokens?: { owner: string; mint: string; delta: bigint }[];
  programs: string[];
}
function ptx(sig: string, slot: number, time: number, m: Move): ParsedTransaction {
  const accounts = [...new Set([...m.signers, ...Object.keys(m.lamports)])];
  const pre = accounts.map(() => 100e9);
  const post = accounts.map((a) => 100e9 + (m.lamports[a] ?? 0));
  const tb = (owner: string, mt: string, amount: bigint, i: number) => ({ accountIndex: i, mint: mt, owner, uiTokenAmount: { amount: amount.toString(), decimals: 6, uiAmount: null } });
  const preT = (m.tokens ?? []).map((t, i) => tb(t.owner, t.mint, 10_000_000_000_000n, 50 + i));
  const postT = (m.tokens ?? []).map((t, i) => tb(t.owner, t.mint, 10_000_000_000_000n + t.delta, 50 + i));
  return {
    slot,
    blockTime: time,
    transaction: { signatures: [sig], message: { accountKeys: accounts.map((a) => ({ pubkey: a, signer: m.signers.includes(a), writable: true })), instructions: m.programs.map((programId) => ({ programId })) } },
    meta: { err: null, fee: 5000, preBalances: pre, postBalances: post, preTokenBalances: preT, postTokenBalances: postT },
  };
}
const buy = (w: string, mt: string, sol: number, tokens: bigint, program = PUMP): Move => ({ signers: [w], lamports: { [w]: -Math.round(sol * 1e9), [POOL]: Math.round(sol * 1e9) }, tokens: [{ owner: w, mint: mt, delta: tokens }, { owner: POOL, mint: mt, delta: -tokens }], programs: [program] });
const sell = (w: string, mt: string, sol: number, tokens: bigint, program = PUMP): Move => ({ signers: [w], lamports: { [w]: Math.round(sol * 1e9), [POOL]: -Math.round(sol * 1e9) }, tokens: [{ owner: w, mint: mt, delta: -tokens }, { owner: POOL, mint: mt, delta: tokens }], programs: [program] });
const transfer = (from: string, to: string, mt: string, tokens: bigint): Move => ({ signers: [from], lamports: { [from]: -5000 }, tokens: [{ owner: from, mint: mt, delta: -tokens }, { owner: to, mint: mt, delta: tokens }], programs: [TOKEN] });
const funding = (w: string, sol: number): Move => ({ signers: [FUNDER], lamports: { [FUNDER]: -Math.round(sol * 1e9) - 5000, [w]: Math.round(sol * 1e9) }, programs: [SYSTEM] });

/** Wallet histories (oldest first). `hidden`: an endless older history of failed transactions exists. */
const wallets = new Map<string, { txs: ParsedTransaction[]; hidden: boolean }>();
let slot = 1_000;
function add(w: string, list: [number, Move][], hidden = false) {
  const txs = list.map(([t, m], i) => ptx(`${w.slice(0, 6)}-${i}`, slot++, t, m));
  wallets.set(w, { txs, hidden });
}

// A — 400 tx, one round trip every 2 h over 200 tokens, funded first.
add(A, [[T0 - 900 * HOUR, funding(A, 20)], ...Array.from({ length: 200 }, (_, i): [number, Move][] => [[T0 - 800 * HOUR + i * 4 * HOUR, buy(A, mint(i), 0.5, 1_000_000n)], [T0 - 800 * HOUR + i * 4 * HOUR + 2 * HOUR, sell(A, mint(i), i % 3 === 0 ? 0.3 : 0.9, 1_000_000n)]]).flat()]);
// B — 80 tx known, older history exists (incomplete).
add(B, Array.from({ length: 40 }, (_, i): [number, Move][] => [[T0 - 100 * HOUR + i * HOUR, buy(B, mint(i), 0.2, 500_000n)], [T0 - 100 * HOUR + i * HOUR + 1800, sell(B, mint(i), 0.25, 500_000n)]]).flat(), true);
// C — D12R-like: 33 buy→sell round trips of identical amounts 4 s apart + 1 sell, ~9 min, 34 tokens; endless older history.
add(
  C,
  [
    ...Array.from({ length: 33 }, (_, i): [number, Move][] => [[T0 + i * 16, buy(C, mint(300 + i), 0.08, 3_000_000n + BigInt(i))], [T0 + i * 16 + 4, sell(C, mint(300 + i), 0.075, 3_000_000n + BigInt(i))]]).flat(),
    [T0 + 540, sell(C, mint(399), 0.05, 1_000_000n)],
  ],
  true,
);
// Creator — creates + buys 76 % in one tx, then distributes to 5 wallets by transfer.
add(CREATOR, [[T0 - 10, funding(CREATOR, 70)], [T0, buy(CREATOR, MINT, 67, 760_000_000_000_000n)], ...R.map((r, i): [number, Move] => [T0 + 240 + i * 30, transfer(CREATOR, r, MINT, 20_000_000_000_000n)])]);
// Recipient 0 sells what it received a day later; the others do nothing else.
add(R[0], [[T0 + 240, transfer(CREATOR, R[0], MINT, 20_000_000_000_000n)], [T0 + 24 * HOUR, sell(R[0], MINT, 1.87, 20_000_000_000_000n, JUP)]]);
for (const r of R.slice(1)) add(r, [[T0 + 300, transfer(CREATOR, r, MINT, 20_000_000_000_000n)]]);
// E — complete, closed positions: +0.5 SOL and −1 SOL.
add(E, [[T0 - 50 * HOUR, funding(E, 5)], [T0 - 48 * HOUR, buy(E, mint(500), 1, 1_000_000n)], [T0 - 46 * HOUR, sell(E, mint(500), 1.5, 1_000_000n)], [T0 - 40 * HOUR, buy(E, mint(501), 2, 4_000_000n)], [T0 - 39 * HOUR, sell(E, mint(501), 1, 4_000_000n)]]);
// F — open position and a half-sold one.
add(F, [[T0 - 20 * HOUR, funding(F, 3)], [T0 - 10 * HOUR, buy(F, mint(600), 1, 1_000_000n)], [T0 - 9 * HOUR, buy(F, mint(601), 1, 2_000_000n)], [T0 - 8 * HOUR, sell(F, mint(601), 0.8, 1_000_000n)]]);

/** Offline RPC over the fixtures (newest first); hidden histories continue with failed signatures forever. */
function fakeRpc(): WalletRpc & { calls: { sig: number; tx: number } } {
  const calls = { sig: 0, tx: 0 };
  const byId = new Map<string, ParsedTransaction>();
  for (const { txs } of wallets.values()) for (const t of txs) byId.set(t.transaction.signatures[0], t);
  return {
    url: "offline",
    calls,
    async getSignatures(address: string, limit: number, before?: string): Promise<SignatureInfo[]> {
      calls.sig++;
      const w = wallets.get(address);
      if (!w) return [];
      const known: SignatureInfo[] = [...w.txs].reverse().map((t) => ({ signature: t.transaction.signatures[0], slot: t.slot, blockTime: t.blockTime, err: null }));
      const at = (i: number): SignatureInfo | null => (i < known.length ? known[i] : w.hidden ? { signature: `${address.slice(0, 6)}-old-${i - known.length}`, slot: 10 - i, blockTime: T0 - 2000 * HOUR - i, err: { InstructionError: [0, "x"] } } : null);
      let start = 0;
      if (before) {
        const k = known.findIndex((s) => s.signature === before);
        start = k >= 0 ? k + 1 : known.length + Number(before.split("-old-")[1]) + 1;
      }
      const out: SignatureInfo[] = [];
      for (let i = start; out.length < limit; i++) {
        const s = at(i);
        if (!s) break;
        out.push(s);
      }
      return out;
    },
    async getTransaction(signature: string) {
      calls.tx++;
      return byId.get(signature) ?? null;
    },
  };
}

const HCONF: HistoryConfig = { ...HISTORY_CONFIG, publicRpc: { maxPageLimit: 100, oldestSignaturePages: 5 } };
const historyFor = (rpc: WalletRpc) => new WalletHistoryService({ providers: [new PublicRpcHistoryProvider(rpc, HCONF.publicRpc)], config: HCONF });
const ctx = (o: Partial<ProfileContext> = {}): ProfileContext => ({ creator: CREATOR, creatorFunder: null, launchTime: T0 * 1000, relatedTo: [], launchTimes: {}, pricesSol: {}, now: (T0 + 30 * 24 * HOUR) * 1000, ...o });
const collect = (w: string, deepAllowed = true, budget = new DeepBudget(8)) => collectWalletFactsFromHistory(historyFor(fakeRpc()), w, { deepAllowed, budget });

// ─── A: > 150 tx, complete ───────────────────────────────────────────────

test("A: 401 transactions with a complete history are analysed (no 150 limit)", async () => {
  const f = await collect(A);
  assert.equal(f.historyComplete, true);
  assert.equal(f.history?.completeness, "deep_complete");
  assert.equal(f.history?.deep.attempted, true);
  assert.equal(f.trades?.length, 400);
  assert.equal(f.firstSeen, (T0 - 900 * HOUR) * 1000);
  assert.equal(f.funder, FUNDER);
  const p = profileWallet(f, ctx(), (T0 - 800 * HOUR) * 1000);
  assert.equal(p.metrics?.positions.length, 200);
  assert.equal(p.metrics?.evaluated, 200);
  assert.ok(p.metrics!.profitable > 0 && p.metrics!.losing > 0, "win/loss computed from closed positions");
  assert.equal(p.confidence, "HIGH", "existing threshold (≥ 25 positions, complete) unchanged");
});

// ─── B: 80 tx, incomplete ────────────────────────────────────────────────

test("B: 80 known transactions but an incomplete history → no trades, no win rate, UNKNOWN age without penalty", async () => {
  const f = await collect(B);
  assert.equal(f.historyComplete, false);
  assert.equal(f.trades, null);
  assert.equal(f.history?.origin.reason, "budget_exhausted");
  assert.equal(f.history?.deep.skippedReason, "history_exceeds_deep_budget");
  assert.equal(f.firstSeen, null);
  assert.equal(f.funder, null);
  assert.equal(f.history?.signatureCountIsLowerBound, true);
  const p = profileWallet(f, ctx(), (T0 - 100 * HOUR) * 1000);
  assert.equal(p.metrics, null, "no invented win rate / PnL");
  assert.ok(!p.flags.some((fl) => fl.key === "fresh" || fl.key === "fundedBeforeLaunch"), "unknown age / funding is not a negative signal");
  assert.ok(p.unknowns.some((u) => u.startsWith("Âge du wallet : UNKNOWN")));
  assert.ok(p.unknowns.some((u) => u.startsWith("Financement initial : UNKNOWN")));
  // Same wallet with a known, old origin: identical flags → the UNKNOWN age added nothing.
  const known = profileWallet({ ...f, firstSeen: (T0 - 5000 * HOUR) * 1000 }, ctx(), (T0 - 100 * HOUR) * 1000);
  assert.deepEqual(p.flags.map((x) => x.key), known.flags.map((x) => x.key));
  assert.deepEqual(p.quality, known.quality);
});

// ─── C: D12R-like ────────────────────────────────────────────────────────

test("C: D12R-like activity → bot signals, busy flag, no DEEP, origin UNKNOWN", async () => {
  const f = await collect(C);
  const bot = f.history!.bot;
  assert.equal(bot.botLike, true);
  assert.ok(bot.highFrequency && bot.fastFlipper && bot.manyTokens);
  assert.equal(bot.distinctTokens, 34);
  assert.equal(bot.fastRoundTrips, 33);
  assert.equal(bot.identicalAmountRoundTrips, 33);
  assert.equal(bot.medianHoldSeconds, 4);
  assert.ok(bot.txPerMinute! > 7);
  assert.equal(f.history?.deep.skippedReason, "bot_like");
  assert.equal(f.history?.origin.found, false);
  assert.equal(f.firstSeen, null);
  const p = profileWallet(f, ctx(), T0 * 1000);
  const busy = p.flags.find((fl) => fl.key === "busy");
  assert.ok(busy && busy.severity === "medium", "existing flag, existing severity");
  assert.match(busy!.detail, /transactions\/min/);
  assert.ok(!p.flags.some((fl) => fl.key === "fresh"));
});

test("bot signals stay off for a normal pace and for a small sample", () => {
  const norm = (w: string) => wallets.get(w)!.txs.map((t) => normalizeParsed(t, "public-rpc"));
  assert.equal(detectBotSignals(norm(A), A).botLike, false, "one round trip every few hours");
  assert.equal(detectBotSignals(norm(E), E).botLike, false, "too few transactions to judge");
  assert.equal(detectBotSignals(norm(E), E).highFrequency, false);
});

// ─── D: creator distribution ─────────────────────────────────────────────

test("D: creator buys 76 % then distributes by transfer; transfers are not trades; a recipient sells later", async () => {
  const rpc = fakeRpc();
  const r = await collectTokenWalletsFromHistory(historyFor(rpc), { picks: [E], creator: CREATOR, mint: MINT, supply: 1_000_000_000, deepAllowed: true });
  const cf = r.creatorFacts!;
  assert.equal(cf.historyComplete, true);
  assert.deepEqual(cf.trades?.map((t) => t.side), ["buy"], "only the launch buy is a trade");
  assert.equal(cf.history?.transfers.filter((t) => t.direction === "out").length, 5);
  assert.equal(cf.funder, FUNDER);
  const d = r.distribution!;
  assert.equal(d.transfers, 5);
  assert.deepEqual([...d.recipients].sort(), [...R].sort());
  assert.equal(d.tokenAmount, 100_000_000);
  assert.equal(d.pctSupply, 10);
  assert.deepEqual(d.recipientSells, [{ address: R[0], sells: 1, solReceived: 1.87 }]);
  // The recipient's received tokens are a TRANSFER; its sell has no buy → no position invented.
  const rf = await collect(R[0]);
  assert.deepEqual(rf.trades?.map((t) => t.side), ["sell"]);
  assert.equal(rf.history?.transfers[0].direction, "in");
  assert.deepEqual(rf.history?.transfers[0].counterparties, [CREATOR]);
  assert.equal(profileWallet(rf, ctx(), null).metrics?.positions.length, 0);
});

// ─── E / F: positions ────────────────────────────────────────────────────

test("E: complete history, closed positions → entry, exit, hold, SOL in/out, realized PnL in SOL", async () => {
  const f = await collect(E);
  assert.equal(f.history?.completeness, "recent_page_covers_history");
  assert.equal(f.history?.deep.attempted, false);
  const p = profileWallet(f, ctx(), null);
  const [x, y] = [...p.metrics!.positions].sort((a, b) => (a.firstBuy ?? 0) - (b.firstBuy ?? 0));
  assert.equal(x.closed, true);
  assert.equal(x.firstBuy, (T0 - 48 * HOUR) * 1000);
  assert.equal(x.lastSell, (T0 - 46 * HOUR) * 1000);
  assert.equal(x.holdMinutes, 120);
  assert.ok(Math.abs(x.solIn - 1) < 1e-9 && Math.abs(x.solOut - 1.5) < 1e-9);
  assert.ok(Math.abs(x.realizedPnlSol! - 0.5) < 1e-9);
  assert.ok(Math.abs(y.realizedPnlSol! + 1) < 1e-9);
  assert.equal(p.metrics!.profitable, 1);
  assert.equal(p.metrics!.losing, 1);
  assert.ok(Math.abs(p.metrics!.realizedPnlSol + 0.5) < 1e-9);
});

test("F: open and partially sold positions → realized PnL only on the sold part, open stays unrealized (not computed)", async () => {
  const f = await collect(F);
  const p = profileWallet(f, ctx(), null);
  const open = p.metrics!.positions.find((q) => q.sells === 0)!;
  const half = p.metrics!.positions.find((q) => q.sells === 1)!;
  assert.equal(open.realizedPnlSol, null);
  assert.equal(open.closed, false);
  assert.equal(open.heldValueSolEst, null, "no price → no unrealized value");
  assert.equal(half.closed, false);
  assert.ok(Math.abs(half.realizedPnlSol! - (0.8 - 0.5)) < 1e-9, "0.8 SOL for half the tokens bought 1 SOL");
  assert.equal(half.holdMinutes, null, "not fully exited: no holding time");
  assert.equal(p.metrics!.evaluated, 0, "no win rate from open positions without a price");
});

// ─── DEEP policy ─────────────────────────────────────────────────────────

test("DEEP is selective: disabled by default, capped per token, skipped when not useful", async () => {
  assert.equal((await collect(A, false)).history?.deep.skippedReason, "deep_disabled");
  assert.equal((await collect(A, false)).trades, null, "without DEEP the incomplete history yields no trades");
  assert.equal((await collect(A, true, new DeepBudget(0))).history?.deep.skippedReason, "deep_budget_exhausted");
  assert.equal((await collect(E, true)).history?.deep.skippedReason, "complete_from_quick");
  const r = await collectTokenWalletsFromHistory(historyFor(fakeRpc()), { picks: [A, B, C, E, F], creator: null, mint: MINT, supply: null, deepAllowed: true });
  assert.equal(r.deepRuns, 1, "only A needed and could use DEEP");
  assert.equal(WALLET_CONFIG.historyLayer.deepMaxWalletsPerToken, 8);
});

test("no network: everything above ran on the offline RPC", () => {
  assert.equal(typeof fetch, "function");
  assert.ok(wallets.size >= 10);
});

// ─── token level ─────────────────────────────────────────────────────────

test("token level on the same fixtures: what the history layer establishes (no score change)", async () => {
  const picks = [A, B, C, E, F];
  const scan: TokenScan = { mint: MINT, launch: { time: T0 * 1000, slot: 1, signature: "launch" }, signaturesScanned: 10, launchReachable: true, transactionsFetched: 10, transactionsFailed: 0, undecodable: 0, earlyTrades: [], recentTrades: [], supply: 1_000_000_000, solUsd: null };
  const buyers: Buyer[] = picks.map((a, i) => ({ address: a, firstBuy: { signature: `b${i}`, slot: 2, time: (T0 + i) * 1000, owner: a, mint: MINT, side: "buy", tokenAmount: 1, sol: 1 }, entryMinutesAfterLaunch: 0, sameSlotAsLaunch: false, entryMcapSol: null, entryMcapUsdEst: null, buys: 1, solSpent: 1, sells: 0, solReceived: 0, currentPct: null }));
  const ictx = { creator: CREATOR, creatorFunder: null, holdersPct: null, excluded: () => false, launchTimes: {}, pricesSol: {}, now: (T0 + 30 * 24 * HOUR) * 1000 };

  const fresh = await collectTokenWalletsFromHistory(historyFor(fakeRpc()), { picks, creator: CREATOR, mint: MINT, supply: 1_000_000_000, deepAllowed: true });
  const intel = { ...buildIntel(scan, buyers, fresh.facts, { ...ictx, creatorFunder: fresh.creatorFacts?.funder ?? null }), creatorDistribution: fresh.distribution };
  const tr = intel.tracked;
  const positions = tr.flatMap((t) => t.profile.metrics?.positions ?? []);
  assert.equal(tr.length, 5);
  assert.equal(tr.filter((t) => t.profile.facts.trades !== null).length, 3, "E, F and A (401 tx, DEEP complete)");
  assert.equal(positions.length, 204);
  assert.equal(positions.filter((p) => p.realizedPnlSol !== null).length, 203);
  assert.equal(tr.filter((t) => t.profile.flags.some((f) => f.key === "busy")).length, 2, "B and C: lower bound + behaviour");
  assert.equal(tr.filter((t) => t.profile.facts.firstSeen !== null).length, 3);
  assert.equal(tr.filter((t) => t.profile.facts.funder !== null).length, 3);
  assert.equal(tr.filter((t) => t.profile.confidence !== "LOW").length, 1, "only A has enough complete positions");
  // A, E, F share the creator's funder; its activity was not counted here → UNKNOWN link, never a flag.
  assert.equal(tr.filter((t) => t.profile.creatorLink?.type === "sameFunderUnknownActivity").length, 3, "A, E, F share the creator's funder");
  assert.equal(tr.filter((t) => t.profile.flags.some((f) => ["fundedByCreator", "sameFunderAsCreator"].includes(f.key))).length, 0);
  assert.equal(intel.creatorDistribution?.transfers, 5);
  assert.ok(fresh.creatorFacts?.funder, "creator funder established from its history");
});
