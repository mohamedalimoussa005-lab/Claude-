/**
 * Fixture collector for the coordination analysis (read-only, free public RPC, no key needed).
 *
 *   NODE_USE_ENV_PROXY=1 node --experimental-strip-types --no-warnings scripts/social/coordination-capture.ts \
 *       <mint> <out.json> [--rpc URL] [--early 250] [--wallets 50] [--hops 2] [--wallet-txs 6] [--max-pages 300]
 *
 * It reads: the signature list of the mint (until its first transaction or --max-pages), the earliest --early
 * transactions, then for each launch-cohort wallet (and its funder, up to --hops) the oldest transactions.
 * Transactions are stored compacted to the fields normalize.ts reads. Nothing is written but --out; the tests never
 * run this script. Coverage (complete / capped / missing) is stored with the data and surfaces in every result.
 */

import { writeFileSync } from "node:fs";
import { analyzeCoordination } from "../../src/social/coordination/analyze.ts";
import { entityMap } from "../../src/social/coordination/entities.ts";
import { normalizeTx } from "../../src/social/coordination/normalize.ts";
import type { RawTx } from "../../src/social/coordination/normalize.ts";
import { DEFAULT_CONFIG } from "../../src/social/coordination/model.ts";
import type { Coverage } from "../../src/social/coordination/model.ts";

const argv = process.argv.slice(2);
const [mint, out] = argv;
const opt = (name: string, d: number) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const rpcUrl = argv.includes("--rpc") ? argv[argv.indexOf("--rpc") + 1]! : "https://api.mainnet-beta.solana.com";
if (!mint || !out) throw new Error("usage: coordination-capture.ts <mint> <out.json> [options]");
const EARLY = opt("early", 250);
const WALLETS = opt("wallets", DEFAULT_CONFIG.funding.maxWallets);
const HOPS = opt("hops", DEFAULT_CONFIG.funding.maxHops);
const WALLET_TXS = opt("wallet-txs", 6);
const MAX_PAGES = opt("max-pages", 300);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let calls = 0;
async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  for (let attempt = 0; attempt < 7; attempt++) {
    calls++;
    try {
      const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        const j = (await res.json()) as { result?: T; error?: { message: string } };
        if (j.result !== undefined) return j.result;
        // rate limits are retried; any other RPC error is final for this call (counted as missing by the caller)
        if (j.error && !/Too many requests/i.test(j.error.message)) return null;
      }
    } catch {
      /* retry */
    }
    await sleep(1500 + attempt * 2500);
  }
  return null;
}

interface SigInfo { signature: string; slot: number; blockTime: number | null; err: unknown }

/** Signatures newest→oldest until the end of the history or maxPages. Returned oldest first. */
async function listSignatures(address: string, maxPages: number): Promise<{ sigs: SigInfo[]; complete: boolean }> {
  const all: SigInfo[] = [];
  let before: string | undefined;
  for (let p = 0; p < maxPages; p++) {
    const page = await rpc<SigInfo[]>("getSignaturesForAddress", [address, { limit: 1000, ...(before ? { before } : {}) }]);
    if (page === null) return { sigs: all.reverse(), complete: false };
    all.push(...page);
    if (page.length < 1000) return { sigs: all.reverse(), complete: true };
    before = page[page.length - 1]!.signature;
    await sleep(300);
  }
  return { sigs: all.reverse(), complete: false };
}

type Ix = { programId?: string; program?: string; parsed?: { type?: string; info?: Record<string, unknown> } };
const SYS = "11111111111111111111111111111111";
const compactIx = (ix: Ix): Ix => (ix.programId === SYS && ix.parsed ? { programId: SYS, parsed: { type: ix.parsed.type, info: ix.parsed.info } } : { programId: ix.programId });

function compact(raw: any, keepTokens: boolean): RawTx {
  return {
    slot: raw.slot,
    blockTime: raw.blockTime ?? null,
    meta: {
      err: raw.meta.err,
      fee: raw.meta.fee,
      preBalances: raw.meta.preBalances,
      postBalances: raw.meta.postBalances,
      ...(keepTokens ? { preTokenBalances: (raw.meta.preTokenBalances ?? []).map(tb), postTokenBalances: (raw.meta.postTokenBalances ?? []).map(tb) } : {}),
      innerInstructions: (raw.meta.innerInstructions ?? []).map((g: any) => ({ index: g.index, instructions: g.instructions.map(compactIx) })),
    },
    transaction: { signatures: [raw.transaction.signatures[0]], message: { accountKeys: raw.transaction.message.accountKeys.map((k: any) => ({ pubkey: k.pubkey, signer: k.signer })), instructions: raw.transaction.message.instructions.map(compactIx) } },
  };
}
const tb = (b: any) => ({ accountIndex: b.accountIndex, mint: b.mint, owner: b.owner, uiTokenAmount: { amount: b.uiTokenAmount.amount } });

async function fetchTxs(sigs: string[], keepTokens: boolean): Promise<{ txs: RawTx[]; missing: number }> {
  const txs: RawTx[] = [];
  let missing = 0;
  for (const s of sigs) {
    const raw = await rpc<any>("getTransaction", [s, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
    if (!raw || !raw.meta) missing++;
    else txs.push(compact(raw, keepTokens));
    if ((txs.length + missing) % 25 === 0) console.error(`  ... ${txs.length + missing}/${sigs.length} transactions (${missing} missing)`);
    await sleep(250);
  }
  return { txs, missing };
}

const coverageOf = (listed: SigInfo[], complete: boolean, read: number, missing: number, notes: string[]): Coverage => ({
  signaturesComplete: complete,
  signaturesRead: listed.length,
  transactionsRead: read,
  transactionsMissing: missing,
  oldestSlot: listed[0]?.slot ?? null,
  newestSlot: listed[listed.length - 1]?.slot ?? null,
  notes,
});

/** --merge <capture.json> --extra a,b: add the funding histories of extra wallets (e.g. the creator) to an existing capture. */
async function mergeExtra(file: string, extra: string[]) {
  const cap = JSON.parse((await import("node:fs")).readFileSync(file, "utf8"));
  const wallets: Record<string, { coverage: Coverage; activityCapped: boolean; txs: RawTx[] }> = cap.wallets;
  async function capture(w: string) {
    if (wallets[w]) return;
    const l = await listSignatures(w, 3);
    const eligible = l.sigs.filter((s) => s.err === null).slice(0, WALLET_TXS);
    const f = await fetchTxs(eligible.map((s) => s.signature), false);
    wallets[w] = { activityCapped: !l.complete, coverage: coverageOf(l.sigs, l.complete, f.txs.length, f.missing, l.complete ? [] : ["historique plafonné à 3 pages de signatures (très actif)"]), txs: f.txs };
  }
  let frontier = extra;
  for (let hop = 1; hop <= HOPS; hop++) {
    for (const w of frontier) await capture(w);
    const next = new Set<string>();
    for (const w of frontier) for (const t of wallets[w]!.txs) { const n = normalizeTx(t); const tr = n.solTransfers.find((x) => x.to === w && x.lamports >= DEFAULT_CONFIG.funding.minFundingLamports); if (tr) { next.add(tr.from); break; } }
    frontier = [...next].filter((x) => !wallets[x] && !entityMap().has(x));
  }
  writeFileSync(file, JSON.stringify(cap));
  console.error(`merged ${Object.keys(wallets).length} wallets, ${calls} rpc calls`);
}

async function main() {
  const t0 = Date.now();
  if (argv.includes("--merge")) return mergeExtra(argv[argv.indexOf("--merge") + 1]!, argv[argv.indexOf("--extra") + 1]!.split(","));
  const { sigs, complete } = await listSignatures(mint!, MAX_PAGES);
  console.error(`mint ${mint}: ${sigs.length} signatures, complete=${complete}`);
  const early = sigs.filter((s) => s.err === null).slice(0, EARLY);
  const { txs, missing } = await fetchTxs(early.map((s) => s.signature), true);
  const supply = await rpc<{ value: { amount: string } }>("getTokenSupply", [mint]);
  const first = txs.length > 0 ? normalizeTx(txs[0]!) : null;
  const creator = first ? first.feePayer : null;
  const mintCov = coverageOf(sigs, complete, txs.length, missing, complete ? [] : [`liste de signatures plafonnée à ${MAX_PAGES} pages`]);

  // cohort exactly as the analysis will define it (same code path, no funding history yet)
  const base = analyzeCoordination({ mint: mint!, creator, supplyRaw: supply ? BigInt(supply.value.amount) : null, txs: txs.map(normalizeTx), coverage: mintCov, provider: () => null });
  const cohort = base.launch.cohort.map((m) => m.wallet).slice(0, WALLETS);
  console.error(`cohort ${cohort.length} wallets (quote mint ${base.quoteMint}, ${base.swaps.length} swaps read)`);

  const wallets: Record<string, { coverage: Coverage; activityCapped: boolean; txs: RawTx[] }> = {};
  async function capture(w: string) {
    if (wallets[w]) return;
    const l = await listSignatures(w, 3);
    const eligible = l.sigs.filter((s) => s.err === null).slice(0, WALLET_TXS);
    const f = await fetchTxs(eligible.map((s) => s.signature), false);
    wallets[w] = { activityCapped: !l.complete, coverage: coverageOf(l.sigs, l.complete, f.txs.length, f.missing, l.complete ? [] : ["historique plafonné à 3 pages de signatures (très actif)"]), txs: f.txs };
  }
  let frontier = cohort;
  for (let hop = 1; hop <= HOPS; hop++) {
    for (const w of frontier) await capture(w);
    if (hop === HOPS) break;
    const next = new Set<string>();
    for (const w of frontier) {
      for (const t of wallets[w]!.txs) {
        const n = normalizeTx(t);
        for (const tr of n.solTransfers) if (tr.to === w && tr.lamports >= DEFAULT_CONFIG.funding.minFundingLamports) { next.add(tr.from); break; }
      }
    }
    frontier = [...next].filter((x) => !wallets[x] && !entityMap().has(x));
    console.error(`hop ${hop + 1}: ${frontier.length} funders`);
  }
  writeFileSync(out!, JSON.stringify({ mint, capturedAt: new Date().toISOString(), rpc: "public", params: { EARLY, WALLETS, HOPS, WALLET_TXS, MAX_PAGES }, creator, supplyRaw: supply?.value.amount ?? null, coverage: mintCov, txs, wallets }));
  console.error(`done in ${Math.round((Date.now() - t0) / 1000)}s, ${calls} rpc calls`);
}
main().catch((e) => { console.error(e); process.exit(1); });
