import { test } from "node:test";
import assert from "node:assert/strict";
import { base58Encode } from "../src/onchain/base58.ts";
import { findRelatedWallets } from "../src/onchain/clusters.ts";
import type { ParsedTransaction, SignatureInfo } from "../src/onchain/rpc.ts";
import type { WalletHistory } from "../src/onchain/types.ts";
import { HISTORY_CONFIG } from "../src/history/config.ts";
import { PublicRpcHistoryProvider } from "../src/history/publicRpc.ts";
import { WalletHistoryService } from "../src/history/service.ts";
import type { WalletRpc } from "../src/wallets/collect.ts";
import { WALLET_CONFIG } from "../src/wallets/config.ts";
import type { WalletIntel } from "../src/wallets/intel.ts";
import { profileWallet } from "../src/wallets/profile.ts";
import { WalletIntelService } from "../src/wallets/service.ts";
import { compareStep3Step4, selectStructuralWallets } from "../src/wallets/structural.ts";
import type { Step3Facts } from "../src/wallets/structural.ts";
import { createServerWalletIntelService, DEFAULT_HISTORY_PATH, parseHistoryPathArgs } from "../src/wallets/server/historyPath.ts";

const key = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const MINT = key(1);
const PAIR = key(2);
const POOL = key(3);
const CREATOR = key(4);
const SINK = key(5);
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const SYSTEM = "11111111111111111111111111111111";
const W = Array.from({ length: 8 }, (_, i) => key(20 + i)); // buyers
const H = Array.from({ length: 3 }, (_, i) => key(50 + i)); // Step 3 holders, not buyers
const T0 = 1_790_000_000;
const HOUR = 3600;

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

/**
 * Offline chain: 8 buyers (distinct funders, one hour apart), 3 holders H
 * (distinct funders) that appear together in one "bundle" transaction.
 * `h2Long`: H2 has 400 more transactions (older and newer than the bundle),
 * so its Step 4 history is incomplete and the bundle is outside what QUICK reads.
 * `w0InGroup`: buyer W0 is also in the bundle (and so in the Step 3 group).
 */
function world(o: { h2Long?: boolean; w0InGroup?: boolean } = {}) {
  const txs = new Map<string, ParsedTransaction>();
  const sigsOf = new Map<string, SignatureInfo[]>();
  let slot = 1;
  const put = (t: ParsedTransaction, addrs: string[]) => {
    txs.set(t.transaction.signatures[0], t);
    for (const a of addrs) sigsOf.set(a, [{ signature: t.transaction.signatures[0], slot: t.slot, blockTime: t.blockTime, err: null }, ...(sigsOf.get(a) ?? [])]);
  };
  const fundTimes = new Map<string, number>();
  // Holders funded 5 days before launch, one hour apart, distinct funders.
  H.forEach((h, j) => {
    const f = key(60 + j);
    const t = T0 - 5 * 86_400 + j * HOUR;
    fundTimes.set(h, t);
    put(ptx(`hfund-${j}`, slot++, t, f, { [f]: -1e9, [h]: 1e9 }, [], SYSTEM), [h]);
  });
  if (o.h2Long) for (let k = 0; k < 30; k++) put(ptx(`old-${k}`, slot++, T0 - 4 * 86_400 + k, H[2], { [H[2]]: -1000, [SINK]: 1000 }, [], SYSTEM), [H[2]]);
  const bundleMembers = o.w0InGroup ? [...H, W[0]] : [...H];
  // W0 must exist before the bundle when it is in it.
  const buyerFundBase = o.w0InGroup ? T0 - 6 * 86_400 : T0 - 86_400;
  W.forEach((w, i) => {
    const f = key(40 + i);
    const t = buyerFundBase + i * HOUR;
    fundTimes.set(w, t);
    put(ptx(`fund-${i}`, slot++, t, f, { [f]: -1e9, [w]: 1e9 }, [], SYSTEM), [w]);
  });
  const bundle = ptx("bundle", slot++, T0 - 2 * 86_400, H[0], Object.fromEntries([...bundleMembers.map((a) => [a, -1_000_000]), [SINK, bundleMembers.length * 1_000_000]]), [], SYSTEM);
  put(bundle, bundleMembers);
  if (o.h2Long) for (let k = 0; k < 370; k++) put(ptx(`new-${k}`, slot++, T0 - 86_400 + 60 + k, H[2], { [H[2]]: -1000, [SINK]: 1000 }, [], SYSTEM), [H[2]]);
  W.forEach((w, i) => {
    const sol = i < 4 ? 0.1 : 1 - (i - 4) * 0.1;
    put(ptx(`buy-${i}`, slot++, T0 + i * 10, w, { [w]: -sol * 1e9, [POOL]: sol * 1e9 }, [{ owner: w, delta: 1_000_000n }, { owner: POOL, delta: -1_000_000n }], PUMP), [w, MINT]);
  });

  let calls = 0;
  const rpc: WalletRpc = {
    url: "offline",
    async getSignatures(address: string, limit: number, before?: string) {
      calls++;
      const list = sigsOf.get(address) ?? [];
      const start = before ? list.findIndex((s) => s.signature === before) + 1 : 0;
      return list.slice(start, start + limit);
    },
    async getTransaction(signature: string) {
      calls++;
      return txs.get(signature) ?? null;
    },
  };

  // Step 3 facts, produced by Step 3's own relationship logic from the holders' histories.
  const pct: Record<string, number> = { [H[0]]: 3, [H[1]]: 2.5, [H[2]]: 2 };
  const step3Wallets: WalletHistory[] = [...H, ...(o.w0InGroup ? [W[0]] : [])].map((a, j) => ({
    address: a,
    pct: pct[a] ?? 0.5,
    signatureCount: sigsOf.get(a)!.length,
    historyComplete: true,
    firstSeen: fundTimes.get(a)! * 1000,
    funder: a === W[0] ? key(40) : key(60 + j),
    fundingSignature: a === W[0] ? "fund-0" : `hfund-${j}`,
    funderSignatureCount: null,
    signatures: sigsOf.get(a)!.map((s) => s.signature),
  }));
  const related = findRelatedWallets(step3Wallets, { closeCreationMinutes: 10, busyFunderSignatures: 1000 });
  const onchain: any = {
    data: {
      owners: { status: "error" },
      mintInfo: { status: "ok", value: { supplyRaw: "1000000000000000", decimals: 6 } },
      creator: { status: "ok", value: { address: CREATOR } },
      holders: { status: "ok", value: { pctByOwner: pct } },
      wallets: { status: "ok", value: step3Wallets },
      creatorActivity: { status: "ok", value: { events: [] } },
    },
    analysis: { related },
  };
  return { rpc, onchain, related, calls: () => calls };
}

const row: any = { pair: { tokenAddress: MINT, pairAddress: PAIR, dexId: "pumpswap", tokenSymbol: "TEST" } };
const dex: any = { getPairsByTokenAddresses: async () => { throw new Error("offline"); } };
const newPath = () => ({ history: ({ rpc: g }: { rpc: WalletRpc }) => new WalletHistoryService({ providers: [new PublicRpcHistoryProvider(g, HISTORY_CONFIG.publicRpc)] }) });
const runNew = (w: ReturnType<typeof world>) => new WalletIntelService(w.rpc, dex, WALLET_CONFIG, newPath()).analyze(row, w.onchain);
const runOld = (w: ReturnType<typeof world>) => new WalletIntelService(w.rpc, dex, WALLET_CONFIG).analyze(row, w.onchain);
const tw = (intel: WalletIntel, a: string) => intel.tracked.find((t) => t.address === a)!;

// Step 3 facts for the pure selection tests.
const holder = (address: string, funder: string | null, o: Partial<WalletHistory> = {}): WalletHistory => ({ address, pct: 1, signatureCount: 10, historyComplete: true, firstSeen: null, funder, fundingSignature: null, funderSignatureCount: null, signatures: [], ...o });
const facts3 = (wallets: WalletHistory[], o: { creator?: string; events?: any[] } = {}): Step3Facts => ({
  data: {
    creator: o.creator ? { status: "ok", value: { address: o.creator, method: "test", evidence: "test" } } : { status: "not_found", reason: "test" },
    wallets: { status: "ok", value: wallets },
    creatorActivity: { status: "ok", value: { solBalance: 0, tokenPct: null, recentSignatures: 0, analyzedTransactions: 0, events: o.events ?? [] } },
  },
  related: findRelatedWallets(wallets, { closeCreationMinutes: 10, busyFunderSignatures: 1000 }),
});
const none = () => false;

// ─── A: 8 buyers + a Step 3 cluster of 3 absent from the buyers ──────────

test("A: 8 buyers + Step 3 cluster of 3 non-buyers → 11 wallets analysed (NEW and OLD), provenance recorded", async () => {
  const w = world();
  for (const intel of [await runNew(w), await runOld(world())]) {
    assert.equal(intel.tracked.length, 11);
    assert.equal(intel.selection?.buyersShortlisted, 8);
    assert.equal(intel.selection?.structuralCandidates, 3);
    assert.equal(intel.selection?.structuralAnalyzed, 3);
    assert.equal(intel.selection?.deduplicatedCandidates, 0);
    assert.equal(intel.selection?.structuralSkipped, 0);
    for (const b of W) assert.equal(tw(intel, b).selectionSource, "buyer");
    for (const h of H) {
      const t = tw(intel, h);
      assert.equal(t.selectionSource, "structural");
      assert.deepEqual(t.structuralReasons, ["strong_shared_tx"]);
      assert.equal(t.structuralRefs?.step3Group, 0);
      assert.equal(t.firstBuy, null, "not a buyer: no entry invented");
      assert.equal(t.entryMinutesAfterLaunch, null);
      assert.equal(t.solSpent, 0);
    }
    assert.equal(intel.buyersIdentified, 8, "structural wallets are not counted as buyers");
  }
  const intel = await runNew(w);
  assert.equal(intel.source, "history");
  assert.ok(intel.selection!.historyStepsBySelectionSource!.structural > 0);
  assert.equal(intel.historyProviders?.primarySuccess, 0);
  assert.ok(intel.historyProviders!.publicRpcSuccess > 0);
});

// ─── B: structural wallet already a buyer ────────────────────────────────

test("B: a structural wallet already shortlisted is deduplicated → buyer_and_structural, no extra slot used", async () => {
  const intel = await runNew(world({ w0InGroup: true }));
  assert.equal(intel.selection?.structuralCandidates, 4);
  assert.equal(intel.selection?.deduplicatedCandidates, 1);
  assert.equal(intel.selection?.structuralAnalyzed, 3);
  assert.equal(intel.tracked.length, 11, "8 buyers + 3 structural, W0 counted once");
  assert.equal(intel.tracked.filter((t) => t.address === W[0]).length, 1);
  const w0 = tw(intel, W[0]);
  assert.equal(w0.selectionSource, "buyer_and_structural");
  assert.deepEqual(w0.structuralReasons, ["strong_shared_tx"]);
  assert.ok(w0.firstBuy !== null, "keeps its buyer entry");
});

// ─── C: cap and deterministic order ──────────────────────────────────────

test("C: 5 eligible wallets → exactly 3 selected, deterministic whatever the input order", () => {
  const addrs = Array.from({ length: 5 }, (_, i) => key(90 + i));
  const mk = (list: string[]) => list.map((a) => holder(a, key(99), { signatures: ["shared"], fundingSignature: `f-${a}` }));
  // All five share one transaction; the funder is busy so the funder link is weak and not a reason.
  const withBusy = (ws: WalletHistory[]) => ws.map((w) => ({ ...w, funderSignatureCount: 1000 }));
  const a = selectStructuralWallets(facts3(withBusy(mk(addrs))), { buyerPicks: [], isExcluded: none });
  const b = selectStructuralWallets(facts3(withBusy(mk([...addrs].reverse()))), { buyerPicks: [], isExcluded: none });
  assert.equal(a.candidates.length, 5);
  assert.equal(a.added.length, 3);
  assert.equal(a.skipped.length, 2);
  assert.deepEqual(a.added.map((x) => x.address), b.added.map((x) => x.address));
  assert.deepEqual(a.added.map((x) => x.address), [...addrs].sort().slice(0, 3), "same priority and group → address order");
  assert.ok(a.added.every((x) => x.reasons.length === 1 && x.reasons[0] === "strong_shared_tx"));
});

// ─── D: busy common funder only ──────────────────────────────────────────

test("D: busy common funder (weak) → no structural candidate, even funded close together", () => {
  const busy = key(98);
  const far = [0, 1, 2].map((i) => holder(key(80 + i), busy, { funderSignatureCount: 1000, firstSeen: T0 * 1000 + i * 3 * HOUR * 1000, fundingSignature: `f${i}` }));
  const r1 = facts3(far);
  assert.ok(r1.related!.links.every((l) => l.type === "sameBusyFunder" && l.strength === "weak"));
  assert.equal(selectStructuralWallets(r1, { buyerPicks: [], isExcluded: none }).candidates.length, 0);
  // Same busy funder within 10 min: Step 3 marks it strong (sameFunderClose), the bridge still does not use it.
  const close = [0, 1, 2].map((i) => holder(key(80 + i), busy, { funderSignatureCount: 1000, firstSeen: T0 * 1000 + i * 60_000, fundingSignature: `f${i}` }));
  const r2 = facts3(close);
  assert.ok(r2.related!.links.some((l) => l.type === "sameFunderClose"));
  assert.equal(selectStructuralWallets(r2, { buyerPicks: [], isExcluded: none }).candidates.length, 0);
  // Unknown activity (never counted) is not evidence either.
  const unknown = [0, 1, 2].map((i) => holder(key(80 + i), busy, { firstSeen: T0 * 1000 + i * 3 * HOUR * 1000, fundingSignature: `f${i}` }));
  assert.equal(selectStructuralWallets(facts3(unknown), { buyerPicks: [], isExcluded: none }).candidates.length, 0);
  // Size, recency and UNKNOWN funding alone never qualify.
  const loners = [holder(key(85), null, { pct: 40 }), holder(key(86), null, { firstSeen: Date.now() })];
  assert.equal(selectStructuralWallets(facts3(loners), { buyerPicks: [], isExcluded: none }).candidates.length, 0);
});

test("D bis: a counted non-busy funder shared by 3 holders at different times → non_busy_common_funder", () => {
  const f = key(97);
  const ws = [0, 1, 2].map((i) => holder(key(80 + i), f, { funderSignatureCount: 40, firstSeen: T0 * 1000 + i * 3 * HOUR * 1000, fundingSignature: `f${i}` }));
  const s = selectStructuralWallets(facts3(ws), { buyerPicks: [], isExcluded: none });
  assert.equal(s.candidates.length, 3);
  assert.ok(s.candidates.every((x) => x.reasons.includes("non_busy_common_funder") && x.priority === 3));
  // Only two holders share it → not "several holders".
  assert.equal(selectStructuralWallets(facts3(ws.slice(0, 2)), { buyerPicks: [], isExcluded: none }).candidates.length, 0);
});

// ─── E: strong sharedTx wallets ──────────────────────────────────────────

test("E: 3 wallets with strong sharedTx edges → structural candidates, priority 2, edges referenced", () => {
  const w = world();
  const s = selectStructuralWallets({ data: w.onchain.data, related: w.related }, { buyerPicks: W, isExcluded: none });
  assert.deepEqual(s.candidates.map((x) => x.address).sort(), [...H].sort());
  for (const c of s.candidates) {
    assert.equal(c.priority, 2);
    assert.deepEqual(c.reasons, ["strong_shared_tx"]);
    assert.equal(c.step3Group, 0);
    assert.equal(c.relatedCount, 3);
    assert.equal(c.edges.length, 2);
    assert.ok(c.edges.every((e) => e.type === "sharedTx" && e.strength === "strong"));
  }
  assert.ok(s.candidates.every((c) => c.address !== CREATOR));
});

// ─── F: deployment-funded wallet first ───────────────────────────────────

test("F: deployment-funded wallet is a structural candidate ahead of a larger strong group; creator and technical accounts never", () => {
  const group = [0, 1, 2].map((i) => holder(key(80 + i), key(70 + i), { pct: 10, signatures: ["shared"], fundingSignature: `f${i}` }));
  const funded = holder(key(89), CREATOR, { pct: 0.1, fundingSignature: "fc" });
  const s = selectStructuralWallets(facts3([...group, funded, holder(CREATOR, null)], { creator: CREATOR }), { buyerPicks: [], isExcluded: (a) => a === key(81) });
  assert.equal(s.added[0].address, key(89));
  // The creator is itself an analysed holder here, so Step 3 also has a strong fundedBy link to it.
  assert.deepEqual(s.added[0].reasons, ["deployment_funded", "strong_funded_by"]);
  assert.equal(s.added[0].priority, 1);
  assert.ok(!s.candidates.some((x) => x.address === CREATOR));
  assert.ok(!s.candidates.some((x) => x.address === key(81)), "technical account excluded");
  // Deployment token transfer ≥ threshold → recipient qualifies; below → not.
  const ev = (pct: number, r: string) => ({ signature: `t-${r}`, time: null, kind: "transfer", tokenDeltaPct: -pct, recipients: [r] });
  const t = selectStructuralWallets(facts3([], { creator: CREATOR, events: [ev(0.5, key(87)), ev(0.01, key(88))] }), { buyerPicks: [], isExcluded: none });
  assert.deepEqual(t.candidates.map((x) => [x.address, x.reasons]), [[key(87), ["deployment_token_recipient"]]]);
});

// ─── G: incomplete structural wallet stays neutral ───────────────────────

test("G: structural wallet with an incomplete history → UNKNOWN, no metrics, no malus from its selection", async () => {
  const intel = await runNew(world({ h2Long: true }));
  const h2 = tw(intel, H[2]);
  assert.equal(h2.selectionSource, "structural");
  const p = h2.profile;
  assert.equal(p.facts.trades, null);
  assert.equal(p.metrics, null, "no PnL / positions invented");
  assert.equal(p.facts.history?.completeness, "incomplete");
  assert.ok(p.flags.every((f) => ["incomplete", "related", "busy"].includes(f.key)), `flags: ${p.flags.map((f) => f.key)}`);
  // Same facts profiled as an ordinary buyer (same context) → same flags, Quality, Confidence.
  const asBuyer = profileWallet(p.facts, { creator: CREATOR, creatorFunder: null, launchTime: intel.scan.launch?.time ?? null, relatedTo: [], launchTimes: {}, pricesSol: {}, now: Date.now() }, null);
  assert.deepEqual(asBuyer.flags.map((f) => f.key), p.flags.map((f) => f.key));
  assert.equal(asBuyer.quality, p.quality);
  assert.equal(asBuyer.confidence, p.confidence);
  // Complete structural wallets get the ordinary metrics.
  assert.ok(tw(intel, H[0]).profile.facts.trades !== null);
});

// ─── H: cluster adjustment ───────────────────────────────────────────────

test("H: 3 related structural wallets count as one independent cluster", async () => {
  const intel = await runNew(world());
  assert.equal(intel.tracked.length, 11);
  const clusters = new Set(H.map((h) => tw(intel, h).cluster));
  assert.equal(clusters.size, 1, "one cluster for the three");
  assert.equal(intel.independentClusters, 9, "8 independent buyers + 1 cluster, not 11 signals");
  for (const h of H) assert.ok(tw(intel, h).profile.flags.some((f) => f.key === "related"));
});

// ─── I / J: Step 3 ↔ Step 4 comparison ───────────────────────────────────

test("I: Step 3 strong sharedTx + Step 4 sees the same transactions → confirmed (Step 4's own evidence)", async () => {
  const intel = await runNew(world());
  const cmp = intel.step3Comparison!;
  const shared = cmp.filter((c) => c.step3.type === "sharedTx");
  assert.equal(shared.length, 3);
  assert.ok(shared.every((c) => c.status === "confirmed"));
  assert.ok(shared.every((c) => c.step4Evidence.some((e) => e.startsWith("sharedTx"))));
});

test("J: Step 4 history too short to see the shared transaction → unknown, never disproved; Step 4 adds no link from Step 3", async () => {
  const intel = await runNew(world({ h2Long: true }));
  const withH2 = intel.step3Comparison!.filter((c) => c.step3.type === "sharedTx" && (c.step3.a === H[2] || c.step3.b === H[2]));
  assert.equal(withH2.length, 2);
  for (const c of withH2) {
    assert.equal(c.status, "unknown");
    assert.match(c.note, /incomplet/);
  }
  assert.ok(!intel.related.links.some((l) => l.type === "sharedTx" && (l.a === H[2] || l.b === H[2])), "no Step 4 link copied from Step 3");
  assert.ok(intel.step3Comparison!.every((c) => (c.status as string) !== "disproved"));
  // not_observed only when Step 4 had what it needed.
  const pure = compareStep3Step4([{ type: "sharedTx", a: H[0], b: H[1], key: null, strength: "strong" }], {
    links: [],
    facts: new Map([H[0], H[1]].map((a) => [a, { address: a, trades: [], funder: null, firstSeen: null } as any])),
    clusterOf: new Map([[H[0], 1], [H[1], 2]]),
  });
  assert.equal(pure[0].status, "not_observed");
  assert.match(pure[0].note, /pas une réfutation/);
});

// ─── K / L: NEW default, OLD explicit ────────────────────────────────────

test("K: NEW history path is the default for backend scripts", async () => {
  assert.equal(DEFAULT_HISTORY_PATH, "new");
  assert.deepEqual(parseHistoryPathArgs([]), { path: "new", deep: false });
  assert.deepEqual(parseHistoryPathArgs(["--history"]), { path: "new", deep: false }, "former opt-in flag still accepted");
  assert.deepEqual(parseHistoryPathArgs(["--deep"]), { path: "new", deep: true });
  const w = world();
  const { service, path, heliusEnabled } = createServerWalletIntelService({ rpc: w.rpc as any, dex, env: {} });
  assert.equal(path, "new");
  assert.equal(heliusEnabled, false, "no key in this env: public RPC history only");
  const intel = await service.analyze(row, w.onchain);
  assert.equal(intel.source, "history");
  assert.equal(intel.tracked.length, 11);
});

test("L: OLD history path stays explicitly invocable", async () => {
  assert.deepEqual(parseHistoryPathArgs(["--old-history"]), { path: "old", deep: false });
  assert.deepEqual(parseHistoryPathArgs(["--old-history", "--deep"]), { path: "old", deep: false }, "DEEP is a NEW-path option");
  const w = world();
  const { service, path } = createServerWalletIntelService({ rpc: w.rpc as any, dex, env: {}, path: "old" });
  assert.equal(path, "old");
  const intel = await service.analyze(row, w.onchain);
  assert.equal(intel.source, "rpc");
  assert.equal(intel.tracked.length, 11);
});

test("bridge disabled (maxWallets 0) → buyers only, as before", async () => {
  const w = world();
  const intel = await new WalletIntelService(w.rpc, dex, { ...WALLET_CONFIG, structural: { ...WALLET_CONFIG.structural, maxWallets: 0 } }, newPath()).analyze(row, w.onchain);
  assert.equal(intel.tracked.length, 8);
  assert.equal(intel.selection?.structuralSkipped, 3);
  assert.ok(intel.tracked.every((t) => t.selectionSource === "buyer"));
});
