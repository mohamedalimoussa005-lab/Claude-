import { test } from "node:test";
import assert from "node:assert/strict";
import { base58Encode } from "../src/onchain/base58.ts";
import { RpcError } from "../src/onchain/rpc.ts";
import type { ParsedTransaction, SignatureInfo } from "../src/onchain/rpc.ts";
import { classifyFailure, CircuitOpenError, RunRpcGuard } from "../src/history/failure.ts";
import { HISTORY_CONFIG } from "../src/history/config.ts";
import { normalizeParsed } from "../src/history/normalize.ts";
import { ProviderUnavailableError } from "../src/history/provider.ts";
import { PublicRpcHistoryProvider } from "../src/history/publicRpc.ts";
import { WalletHistoryService } from "../src/history/service.ts";
import type { HistoryPage, PageRequest, WalletHistoryProvider } from "../src/history/types.ts";
import type { WalletRpc } from "../src/wallets/collect.ts";
import { WALLET_CONFIG } from "../src/wallets/config.ts";
import { profileWallet } from "../src/wallets/profile.ts";
import { WalletIntelService } from "../src/wallets/service.ts";
import type { WalletIntel } from "../src/wallets/intel.ts";

const key = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const MINT = key(1);
const PAIR = key(2);
const POOL = key(3);
const CREATOR = key(4);
const FUNDER = key(5);
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const SYSTEM = "11111111111111111111111111111111";
const W = Array.from({ length: 8 }, (_, i) => key(20 + i)); // W[0] … W[7] = wallets #1 … #8
const T0 = 1_790_000_000;
const QUOTA_MSG = "You have used your data allowance";

// ─── fixtures: 8 buyers of MINT, each funded by FUNDER then buying once ──

function ptx(sig: string, slot: number, time: number, signer: string, lamports: Record<string, number>, tokens: { owner: string; delta: bigint }[], program: string): ParsedTransaction {
  const accounts = [...new Set([signer, ...Object.keys(lamports)])];
  const tb = (owner: string, amount: bigint, i: number) => ({ accountIndex: i, mint: MINT, owner, uiTokenAmount: { amount: amount.toString(), decimals: 6, uiAmount: null } });
  return {
    slot,
    blockTime: time,
    transaction: { signatures: [sig], message: { accountKeys: accounts.map((a) => ({ pubkey: a, signer: a === signer, writable: true })), instructions: [{ programId: program }] } },
    meta: { err: null, fee: 5000, preBalances: accounts.map(() => 100e9), postBalances: accounts.map((a) => 100e9 + (lamports[a] ?? 0)), preTokenBalances: tokens.map((t, i) => tb(t.owner, 1_000_000_000_000n, 10 + i)), postTokenBalances: tokens.map((t, i) => tb(t.owner, 1_000_000_000_000n + t.delta, 10 + i)) },
  };
}
const txs = new Map<string, ParsedTransaction>();
const sigsOf = new Map<string, SignatureInfo[]>();
const addSig = (addr: string, t: ParsedTransaction) => sigsOf.set(addr, [{ signature: t.transaction.signatures[0], slot: t.slot, blockTime: t.blockTime, err: null }, ...(sigsOf.get(addr) ?? [])]);
W.forEach((w, i) => {
  const fund = ptx(`fund-${i}`, 10 + i, T0 - 86_400 + i, FUNDER, { [FUNDER]: -1e9, [w]: 1e9 }, [], SYSTEM);
  // #1–#4 earliest (small), #5–#8 later and larger: shortlist order is #1 … #8.
  const sol = i < 4 ? 0.1 : 1 - (i - 4) * 0.1;
  const buy = ptx(`buy-${i}`, 100 + i, T0 + i * 10, w, { [w]: -sol * 1e9, [POOL]: sol * 1e9 }, [{ owner: w, delta: 1_000_000n }, { owner: POOL, delta: -1_000_000n }], PUMP);
  for (const t of [fund, buy]) txs.set(t.transaction.signatures[0], t);
  addSig(w, fund);
  addSig(w, buy);
  addSig(MINT, buy);
});

type Fault = (method: "sig" | "tx", arg: string, n: number) => Error | null;
/** Offline RPC; `fault` may throw on a call; calls are counted per address/signature. */
function fakeRpc(fault: Fault = () => null) {
  const calls = new Map<string, number>();
  const bump = (k: string) => calls.set(k, (calls.get(k) ?? 0) + 1);
  const rpc: WalletRpc = {
    url: "offline",
    async getSignatures(address: string, limit: number, before?: string) {
      bump(address);
      const err = fault("sig", address, calls.get(address)!);
      if (err) throw err;
      const list = sigsOf.get(address) ?? [];
      const start = before ? list.findIndex((s) => s.signature === before) + 1 : 0;
      return list.slice(start, start + limit);
    },
    async getTransaction(signature: string) {
      bump(signature);
      const err = fault("tx", signature, calls.get(signature)!);
      if (err) throw err;
      return txs.get(signature) ?? null;
    },
  };
  return { rpc, calls, callsFor: (w: string) => (calls.get(w) ?? 0) + [...calls].filter(([k]) => k.includes(`-${W.indexOf(w)}`)).reduce((s, [, n]) => s + n, 0) };
}
const quota = (method: string) => new RpcError("rpc", method, `RPC error 413: ${QUOTA_MSG}`, 413);
const timeout = (method: string) => new RpcError("timeout", method, "RPC timeout after 20000 ms");

const row: any = { pair: { tokenAddress: MINT, pairAddress: PAIR, dexId: "pumpswap", tokenSymbol: "TEST" } };
const onchain: any = {
  data: {
    owners: { status: "error" },
    mintInfo: { status: "ok", value: { supplyRaw: "1000000000000000", decimals: 6 } },
    creator: { status: "ok", value: { address: CREATOR } },
    holders: { status: "error" },
  },
};
const dex: any = { getPairsByTokenAddresses: async () => { throw new Error("offline"); } };
/** History layer over the run's guarded RPC (public-RPC provider), as the server does without Helius. */
const publicHistory: ConstructorParameters<typeof WalletIntelService>[3] = { history: ({ rpc }) => new WalletHistoryService({ providers: [new PublicRpcHistoryProvider(rpc, HISTORY_CONFIG.publicRpc)] }) };
const run = (rpc: WalletRpc, options: ConstructorParameters<typeof WalletIntelService>[3] = publicHistory) => new WalletIntelService(rpc, dex, WALLET_CONFIG, options).analyze(row, onchain);
const byAddr = (intel: WalletIntel, w: string) => intel.tracked.find((t) => t.address === w)!;

// ─── classification ──────────────────────────────────────────────────────

test("RPC 413 'data allowance' → quota_exhausted; other failures get their own code", () => {
  assert.equal(classifyFailure(quota("getTransaction")), "quota_exhausted");
  assert.equal(classifyFailure(new RpcError("rpc", "x", `RPC error -1: ${QUOTA_MSG}`, -1)), "quota_exhausted", "wording alone is enough");
  assert.equal(classifyFailure(timeout("x")), "timeout");
  assert.equal(classifyFailure(new RpcError("network", "x", "RPC network error: fetch failed")), "network");
  assert.equal(classifyFailure(new RpcError("rate_limit", "x", "RPC rate limited (429)", 429)), "rate_limited");
  assert.equal(classifyFailure(new RpcError("parse", "x", "Invalid JSON")), "invalid_response");
  assert.equal(classifyFailure(new RpcError("rpc", "x", "RPC error -32601: Method not found", -32601)), "method_unavailable");
  assert.equal(classifyFailure(new RpcError("rpc", "x", "RPC error -32000: boom", -32000)), "rpc_error");
  assert.equal(classifyFailure(new Error("?")), "unknown");
  assert.equal(classifyFailure(new ProviderUnavailableError("helius", "unavailable", "x")), "method_unavailable");
});

// ─── A / I: quota on wallet #3, circuit breaker ──────────────────────────

test("A/I: wallet #3 hits RPC 413 → circuit open, wallets #4–#8 and the creator send no call, token PARTIAL", async () => {
  let broken = false;
  const f = fakeRpc((m, arg) => {
    if (arg === W[2] && m === "sig") broken = true;
    return broken ? quota(m) : null;
  });
  const intel = await run(f.rpc);
  assert.equal(intel.analysisStatus, "partial");
  const d = intel.diagnostics;
  assert.equal(d.walletsAttempted, 8);
  assert.equal(d.walletsCompleted, 2);
  assert.equal(d.walletsPartial, 1, "#3 made the call that failed");
  assert.equal(d.walletsSkipped, 5, "#4–#8 were not requested");
  assert.equal(d.rpcCircuit, "unavailable_for_run");
  assert.equal(d.tokenFatal, null);
  assert.ok((d.failureKinds.quota_exhausted ?? 0) >= 6);
  for (const w of W.slice(3)) assert.equal(f.calls.get(w) ?? 0, 0, "no call to the spent RPC for later wallets");
  assert.equal(f.calls.get(CREATOR) ?? 0, 0);
  assert.equal(f.calls.get(FUNDER) ?? 0, 0);
  // Wallets analysed before the failure keep their data.
  assert.ok(byAddr(intel, W[0]).profile.facts.trades !== null);
  assert.equal(byAddr(intel, W[0]).profile.facts.funder, FUNDER);
  const w3 = byAddr(intel, W[2]).profile.facts;
  assert.deepEqual(w3.failure, { kind: "quota_exhausted", stages: [{ stage: "history", kind: "quota_exhausted" }], skipped: false });
  assert.equal(byAddr(intel, W[5]).profile.facts.failure?.skipped, true);
  // H: the upstream wording never reaches the business result.
  assert.ok(!JSON.stringify(intel).includes(QUOTA_MSG));
  assert.ok(!JSON.stringify(intel).includes("413"));
});

test("I: RunRpcGuard fails fast once open; transient errors keep it closed", async () => {
  let n = 0;
  const f = fakeRpc((m) => (++n === 2 ? quota(m) : null));
  const g = new RunRpcGuard(f.rpc);
  await g.getSignatures(W[0], 10);
  await assert.rejects(() => g.getSignatures(W[1], 10));
  assert.equal(g.state, "unavailable_for_run");
  await assert.rejects(() => g.getTransaction("buy-0"), (e) => e instanceof CircuitOpenError && e.kind === "quota_exhausted");
  assert.equal(g.skipped, 1);
  assert.equal(f.calls.get("buy-0") ?? 0, 0);
  const t = new RunRpcGuard(fakeRpc((m, _a, k) => (k === 1 ? timeout(m) : null)).rpc);
  await assert.rejects(() => t.getSignatures(W[0], 10));
  assert.equal(t.state, "healthy");
  assert.equal((await t.getSignatures(W[0], 10)).length, 2);
});

// ─── B: timeout on #3 ────────────────────────────────────────────────────

test("B: wallet #3 times out → only #3 is UNKNOWN, #4–#8 are still analysed", async () => {
  const f = fakeRpc((m, arg) => (arg === W[2] && m === "sig" ? timeout(m) : null));
  const intel = await run(f.rpc);
  assert.equal(intel.analysisStatus, "partial");
  assert.equal(intel.diagnostics.walletsCompleted, 7);
  assert.equal(intel.diagnostics.walletsPartial, 1);
  assert.equal(intel.diagnostics.rpcCircuit, "healthy");
  assert.deepEqual(intel.diagnostics.failureKinds, { timeout: 1 });
  for (const w of W.slice(3)) assert.ok(byAddr(intel, w).profile.facts.trades !== null);
});

// ─── C / D: failures inside one wallet's history ─────────────────────────

test("C: a transaction of wallet #3's history fails → #3 is UNKNOWN (nothing invented), the others are complete", async () => {
  // Call 1 of buy-2 is the token scan; call 2 is wallet #3's history page.
  const f = fakeRpc((m, arg, n) => (arg === "buy-2" && m === "tx" && n >= 2 ? timeout(m) : null));
  const intel = await run(f.rpc);
  const w3 = byAddr(intel, W[2]).profile;
  assert.equal(w3.facts.trades, null);
  assert.equal(w3.metrics, null, "no PnL / positions");
  assert.equal(w3.facts.funder, null);
  assert.equal(w3.facts.firstSeen, null);
  assert.deepEqual(w3.facts.failure?.stages, [{ stage: "history", kind: "timeout" }]);
  assert.equal(intel.diagnostics.walletsCompleted, 7);
  assert.equal(intel.diagnostics.rpcCircuit, "healthy", "a timeout does not open the circuit");
});

test("D: the funding transaction can't be returned → funding UNKNOWN, no funding flag", async () => {
  const f = fakeRpc((m, arg, n) => (arg === "fund-2" && m === "tx" && n === 1 ? new RpcError("network", m, "RPC network error: socket hang up") : null));
  const intel = await run(f.rpc);
  const w3 = byAddr(intel, W[2]).profile;
  assert.equal(w3.facts.funder, null);
  assert.ok(!w3.flags.some((fl) => fl.key.startsWith("funded") || fl.key === "sameFunderAsCreator"), "unknown funding is no flag");
  for (const w of W.filter((x) => x !== W[2])) assert.equal(byAddr(intel, w).profile.facts.funder, FUNDER);
});

test("token-fatal only when the mint itself can't be listed", async () => {
  const f = fakeRpc((m, arg) => (arg === MINT ? quota(m) : null));
  const intel = await run(f.rpc);
  assert.equal(intel.analysisStatus, "failed");
  assert.equal(intel.diagnostics.tokenFatal, "quota_exhausted");
  assert.equal(intel.tracked.length, 0);
  assert.ok(W.every((w) => (f.calls.get(w) ?? 0) === 0));
});

// ─── E: Helius keeps wallet intelligence while the RPC is out of quota ────

/** A Helius-like provider serving the fixture histories (no RPC). */
function heliusLike(o: { fail?: (address: string) => Error | null } = {}) {
  const stats = { calls: 0 };
  const provider: WalletHistoryProvider = {
    name: "helius",
    async getPage(req: PageRequest): Promise<HistoryPage> {
      stats.calls++;
      const err = o.fail?.(req.address);
      if (err) throw err;
      const list = (sigsOf.get(req.address) ?? []).map((s) => normalizeParsed(txs.get(s.signature)!, "helius-gtfa"));
      const ordered = req.order === "asc" ? [...list].reverse() : list;
      const page = ordered.slice(0, req.limit);
      const n = page.length;
      return { txs: page, nextCursor: null, provider: "helius", strategy: "helius_gtfa", calls: 1, missing: 0, stats: { signaturesRequested: req.limit, signaturesListed: n, transactionsFetched: n, transactionsFromCache: 0, transactionsSucceeded: n, transactionsFailed: null, transactionsNormalized: n, missing: 0 }, trace: [{ source: "helius_primary", result: "success" }], ...(req.order === "asc" ? { reachedStart: true, originStatus: "reached" as const } : {}) };
    },
  };
  return { provider, stats };
}

test("E: RPC out of quota after the token scan, Helius histories still give full wallet intelligence", async () => {
  const f = fakeRpc((m, arg) => (arg === FUNDER ? quota(m) : null)); // the shared-funder check hits the spent quota
  const h = heliusLike();
  const intel = await run(f.rpc, { history: ({ rpc }) => new WalletHistoryService({ providers: [h.provider, new PublicRpcHistoryProvider(rpc, HISTORY_CONFIG.publicRpc)] }) });
  assert.equal(intel.source, "history");
  assert.equal(intel.diagnostics.walletsCompleted, 8, "every wallet came from Helius");
  assert.ok(W.every((w) => byAddr(intel, w).profile.facts.trades !== null && byAddr(intel, w).profile.facts.funder === FUNDER));
  assert.equal(intel.analysisStatus, "partial");
  assert.deepEqual(intel.diagnostics.stages, [{ stage: "funder_check", kind: "quota_exhausted", wallet: null }]);
  assert.equal(intel.diagnostics.rpcCircuit, "unavailable_for_run");
  assert.ok(!JSON.stringify(intel).includes(QUOTA_MSG));
});

test("E: every history provider out of quota → the first wallet fails, the others are not requested", async () => {
  const h = heliusLike({ fail: () => new ProviderUnavailableError("helius", "quota_exhausted", QUOTA_MSG) });
  const f = fakeRpc((m, arg) => (W.includes(arg) ? quota(m) : null));
  const intel = await run(f.rpc, { history: ({ rpc }) => new WalletHistoryService({ providers: [h.provider, new PublicRpcHistoryProvider(rpc, HISTORY_CONFIG.publicRpc)] }) });
  assert.equal(h.stats.calls, 1, "Helius asked once");
  assert.equal(intel.diagnostics.walletsPartial, 1);
  assert.equal(intel.diagnostics.walletsSkipped, 7);
  assert.equal(byAddr(intel, W[0]).profile.facts.failure?.kind, "quota_exhausted");
  assert.equal(intel.diagnostics.stages.find((s) => s.stage === "creator")?.kind, "quota_exhausted", "creator not requested either");
  assert.ok(!JSON.stringify(intel).includes(QUOTA_MSG));
});

// ─── G: provider errors never change Wallet Quality by themselves ─────────

test("G: a provider failure adds no flag and no penalty — same Quality as the same facts without the failure record", async () => {
  const f = fakeRpc((m, arg) => (arg === W[2] ? quota(m) : arg === "buy-4" ? timeout(m) : arg === "fund-5" ? new RpcError("network", m, "x") : null));
  const intel = await run(f.rpc);
  assert.ok(intel.tracked.some((t) => t.profile.facts.failure), "the faults did hit wallet histories");
  for (const t of intel.tracked) {
    const facts = t.profile.facts;
    if (!facts.failure) continue;
    const { failure: _ignored, ...clean } = facts;
    const ctx = { creator: CREATOR, creatorFunder: null, launchTime: T0 * 1000, relatedTo: [], launchTimes: {}, pricesSol: {}, now: (T0 + 86_400) * 1000 };
    const withF = profileWallet(facts, ctx, t.firstBuy?.time ?? null);
    const without = profileWallet(clean, ctx, t.firstBuy?.time ?? null);
    assert.equal(withF.quality, without.quality, `${t.address}: quality`);
    assert.deepEqual(withF.flags.map((x) => x.key), without.flags.map((x) => x.key));
    assert.ok(!withF.flags.some((x) => /quota|timeout|network|failure|error/i.test(x.key + x.label)));
  }
});
