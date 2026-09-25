/**
 * Collects on-chain data for one token through the read-only RPC client.
 *
 * Each section is fetched independently: a failure is recorded as
 * "unavailable" (with the error) and the other sections still run. Nothing
 * here scores anything; see analyze.ts.
 *
 * Calls per token (typical): mint 1 · holders 1 · owners 1 · creator 0–4 ·
 * creator activity ~14 · wallet histories ~2 per wallet.
 */

import { base64ToBytes, base58Encode, pubkeyAt, readU64LE } from "./base58.ts";
import { classifyHolder } from "./classify.ts";
import { KNOWN_PROGRAMS, ONCHAIN_CONFIG, PUMPSWAP_PROGRAM, PUMP_FUN_PROGRAM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./config.ts";
import type { OnchainConfig } from "./config.ts";
import type { ParsedTransaction, SolanaRpc } from "./rpc.ts";
import type {
  CreatorActivity,
  CreatorData,
  CreatorEvent,
  HolderEntry,
  HoldersData,
  MintData,
  MintExtension,
  OnchainData,
  OwnerInfo,
  Section,
  WalletHistory,
} from "./types.ts";

export interface CollectTarget {
  mint: string;
  /** DEX Screener pair address, used to recognise the pool among holders. */
  pairAddress: string | null;
  dexId: string | null;
}

export type OnchainRpc = Pick<
  SolanaRpc,
  "url" | "getParsedAccount" | "getTokenAccountsForMint" | "getMultipleAccounts" | "getSignatures" | "getTransaction" | "getBalanceLamports"
>;

const ok = <T>(value: T): Section<T> => ({ status: "ok", value });
const unavailable = <T>(err: unknown): Section<T> => ({ status: "unavailable", error: err instanceof Error ? err.message : String(err) });
const notFound = <T>(reason: string): Section<T> => ({ status: "not_found", reason });
const DEFAULT_PUBKEY = SYSTEM_PROGRAM; // 32 zero bytes

async function attempt<T>(fn: () => Promise<Section<T>>): Promise<Section<T>> {
  try {
    return await fn();
  } catch (err) {
    return unavailable(err);
  }
}

// ─── mint ──────────────────────────────────────────────────────────────────

async function fetchMint(rpc: OnchainRpc, mint: string): Promise<Section<MintData>> {
  const acc = await rpc.getParsedAccount(mint);
  if (!acc) return notFound("compte mint introuvable");
  if (acc.owner !== TOKEN_PROGRAM && acc.owner !== TOKEN_2022_PROGRAM) return notFound(`compte non détenu par un programme de token (${acc.owner})`);
  const parsed = Array.isArray(acc.data) ? undefined : acc.data.parsed;
  if (parsed?.type !== "mint" || !parsed.info) return notFound("données du mint non décodables");
  const info = parsed.info;
  const text = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  return ok({
    program: acc.owner,
    decimals: Number(info.decimals),
    supplyRaw: String(info.supply),
    mintAuthority: text(info.mintAuthority),
    freezeAuthority: text(info.freezeAuthority),
    extensions: Array.isArray(info.extensions)
      ? (info.extensions as { extension?: string; state?: Record<string, unknown> }[]).map(
          (e): MintExtension => ({ name: String(e.extension), state: e.state ?? {} }),
        )
      : [],
  });
}

// ─── holders ───────────────────────────────────────────────────────────────

interface HolderScan {
  data: HoldersData;
  amounts: Map<string, bigint>;
}

async function fetchHolders(rpc: OnchainRpc, mint: MintData, mintAddress: string, config: OnchainConfig): Promise<HolderScan> {
  const accounts = await rpc.getTokenAccountsForMint(mint.program, mintAddress);
  const amounts = new Map<string, bigint>();
  const counts = new Map<string, number>();
  for (const a of accounts) {
    const bytes = base64ToBytes(a.data);
    if (bytes.length < 40) continue;
    const owner = base58Encode(bytes.subarray(0, 32));
    const amount = readU64LE(bytes, 32);
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
    if (amount > 0n) amounts.set(owner, (amounts.get(owner) ?? 0n) + amount);
  }
  const supply = BigInt(mint.supplyRaw);
  const toPct = (v: bigint) => (supply > 0n ? Number((v * 1_000_000n) / supply) / 10_000 : 0);
  const sorted = [...amounts].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
  const top: HolderEntry[] = sorted.slice(0, config.holders.classifyTop).map(([owner, amount]) => ({
    owner,
    amountRaw: amount.toString(),
    pctOfSupply: toPct(amount),
    tokenAccounts: counts.get(owner) ?? 1,
  }));
  const pctByOwner: Record<string, number> = {};
  for (const [owner, amount] of sorted.slice(0, 200)) pctByOwner[owner] = toPct(amount);
  return { data: { tokenAccounts: accounts.length, holderCount: amounts.size, top, pctByOwner }, amounts };
}

async function fetchOwners(rpc: OnchainRpc, addresses: string[]): Promise<Record<string, OwnerInfo>> {
  const accounts = await rpc.getMultipleAccounts(addresses);
  const out: Record<string, OwnerInfo> = {};
  addresses.forEach((address, i) => {
    const a = accounts[i];
    const keepData = a && (a.owner === PUMP_FUN_PROGRAM || a.owner === PUMPSWAP_PROGRAM);
    out[address] = a
      ? { address, exists: true, program: a.owner, executable: a.executable, lamports: a.lamports, data: keepData ? a.data[0] : undefined }
      : { address, exists: false, program: null, executable: false, lamports: 0 };
  });
  return out;
}

// ─── deployment-associated wallet ──────────────────────────────────────────

/** pump.fun BondingCurve: 8 discriminator, 5 × u64, bool complete, creator pubkey at 49. */
export function decodePumpBondingCurveCreator(dataB64: string): string | null {
  const d = base64ToBytes(dataB64);
  const creator = pubkeyAt(d, 49);
  return creator && creator !== DEFAULT_PUBKEY ? creator : null;
}

/** PumpSwap Pool: base_mint at 43, coin_creator at 211 (layout checked against base_mint). */
export function decodePumpSwapPool(dataB64: string): { baseMint: string | null; coinCreator: string | null } {
  const d = base64ToBytes(dataB64);
  const coinCreator = pubkeyAt(d, 211);
  return { baseMint: pubkeyAt(d, 43), coinCreator: coinCreator && coinCreator !== DEFAULT_PUBKEY ? coinCreator : null };
}

function hasInitializeMint(tx: ParsedTransaction, mint: string): boolean {
  const all = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions)];
  return all.some((ix) => {
    if (typeof ix.parsed !== "object" || !ix.parsed) return false;
    return (ix.parsed.type === "initializeMint" || ix.parsed.type === "initializeMint2") && ix.parsed.info?.mint === mint;
  });
}

async function findCreator(
  rpc: OnchainRpc,
  target: CollectTarget,
  owners: Record<string, OwnerInfo> | null,
  config: OnchainConfig,
): Promise<Section<CreatorData>> {
  // 1. pump.fun bonding curve among the largest holders.
  for (const info of Object.values(owners ?? {})) {
    if (info.program === PUMP_FUN_PROGRAM && info.data) {
      const creator = decodePumpBondingCurveCreator(info.data);
      if (creator) {
        return ok({ address: creator, method: "champ creator de la bonding curve pump.fun", evidence: `bonding curve ${info.address}` });
      }
    }
  }
  // 2. PumpSwap pool (migrated pump.fun token).
  const poolAddr = target.pairAddress;
  if (poolAddr) {
    let pool = owners?.[poolAddr];
    if (!pool && (target.dexId === "pumpswap" || !owners)) {
      const [acc] = await rpc.getMultipleAccounts([poolAddr]);
      if (acc) pool = { address: poolAddr, exists: true, program: acc.owner, executable: acc.executable, lamports: acc.lamports, data: acc.owner === PUMPSWAP_PROGRAM ? acc.data[0] : undefined };
    }
    if (pool?.program === PUMPSWAP_PROGRAM && pool.data) {
      const { baseMint, coinCreator } = decodePumpSwapPool(pool.data);
      if (baseMint === target.mint && coinCreator) {
        return ok({ address: coinCreator, method: "champ coin_creator de la pool PumpSwap", evidence: `pool ${poolAddr} (base_mint vérifié)` });
      }
    }
  }
  // 3. Generic: the fee payer of the mint's creation transaction, if reachable.
  let before: string | undefined;
  for (let page = 0; page < config.creator.mintSignaturePages; page++) {
    const sigs = await rpc.getSignatures(target.mint, 1000, before);
    if (sigs.length === 0) break;
    if (sigs.length < 1000) {
      const oldest = sigs[sigs.length - 1];
      const tx = await rpc.getTransaction(oldest.signature);
      if (!tx) return notFound("transaction de création introuvable");
      if (!hasInitializeMint(tx, target.mint)) return notFound("première transaction trouvée sans initializeMint vérifiable");
      const payer = tx.transaction.message.accountKeys[0]?.pubkey;
      if (!payer) return notFound("fee payer de la création introuvable");
      return ok({ address: payer, method: "fee payer de la transaction de création du mint", evidence: `transaction ${oldest.signature}` });
    }
    before = sigs[sigs.length - 1].signature;
  }
  return notFound(`création du mint hors de portée (plus de ${config.creator.mintSignaturePages * 1000} transactions sur le mint, programme de lancement non reconnu)`);
}

// ─── transaction parsing ───────────────────────────────────────────────────

function tokenDeltas(tx: ParsedTransaction, mint: string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const add = (owner: string | undefined, v: bigint) => {
    if (owner) out.set(owner, (out.get(owner) ?? 0n) + v);
  };
  for (const b of tx.meta?.preTokenBalances ?? []) if (b.mint === mint) add(b.owner, -BigInt(b.uiTokenAmount.amount));
  for (const b of tx.meta?.postTokenBalances ?? []) if (b.mint === mint) add(b.owner, BigInt(b.uiTokenAmount.amount));
  return out;
}

function lamportDelta(tx: ParsedTransaction, address: string): number {
  const i = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey === address);
  if (i < 0 || !tx.meta) return 0;
  return tx.meta.postBalances[i] - tx.meta.preBalances[i];
}

function invokesKnownAmm(tx: ParsedTransaction): boolean {
  const all = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions)];
  return all.some((ix) => KNOWN_PROGRAMS[ix.programId] !== undefined);
}

export function classifyCreatorTx(
  tx: ParsedTransaction,
  signature: string,
  creator: string,
  mint: string,
  supplyRaw: bigint,
  isTechnical: (owner: string) => boolean,
): CreatorEvent {
  const deltas = tokenDeltas(tx, mint);
  const mine = deltas.get(creator) ?? 0n;
  const pctOf = (v: bigint) => (supplyRaw > 0n ? Number((v * 1_000_000n) / supplyRaw) / 10_000 : 0);
  const receivers = [...deltas].filter(([o, d]) => o !== creator && d > 0n).map(([o]) => o);
  let kind: CreatorEvent["kind"] = "other";
  let recipients: string[] = [];
  if (mine < 0n) {
    const toTechnical = receivers.some(isTechnical);
    const solIn = lamportDelta(tx, creator) > 0;
    if (toTechnical || invokesKnownAmm(tx) || solIn) kind = "sell";
    else {
      kind = "transfer";
      recipients = receivers;
    }
  } else if (mine > 0n) kind = "receive";
  return { signature, time: tx.blockTime ? tx.blockTime * 1000 : null, kind, tokenDeltaPct: pctOf(mine), recipients };
}

/** The account that sent SOL to `wallet` in its first transaction. */
export function findFunder(tx: ParsedTransaction, wallet: string, minFundingSol: number): string | null {
  if (!tx.meta) return null;
  const keys = tx.transaction.message.accountKeys;
  const received = lamportDelta(tx, wallet);
  if (received < minFundingSol * 1e9) return null;
  let best: string | null = null;
  let bestDelta = 0;
  keys.forEach((k, i) => {
    if (k.pubkey === wallet) return;
    const fee = i === 0 ? tx.meta!.fee : 0;
    const d = tx.meta!.postBalances[i] - tx.meta!.preBalances[i] + fee;
    if (d < bestDelta) {
      bestDelta = d;
      best = k.pubkey;
    }
  });
  return best;
}

async function fetchCreatorActivity(
  rpc: OnchainRpc,
  creator: string,
  mint: string,
  mintData: MintData | null,
  holders: HolderScan | null,
  isTechnical: (owner: string) => boolean,
  config: OnchainConfig,
): Promise<Section<CreatorActivity>> {
  const lamports = await rpc.getBalanceLamports(creator);
  const sigs = await rpc.getSignatures(creator, config.creator.recentSignatures);
  const supply = mintData ? BigInt(mintData.supplyRaw) : 0n;
  const events: CreatorEvent[] = [];
  let analyzed = 0;
  for (const s of sigs.slice(0, config.creator.analyzeTransactions)) {
    if (s.err) continue;
    const tx = await rpc.getTransaction(s.signature);
    if (!tx) continue;
    analyzed++;
    const e = classifyCreatorTx(tx, s.signature, creator, mint, supply, isTechnical);
    if (e.kind !== "other") events.push(e);
  }
  const held = holders?.amounts.get(creator) ?? 0n;
  return ok({
    solBalance: lamports / 1e9,
    tokenPct: holders && supply > 0n ? Number((held * 1_000_000n) / supply) / 10_000 : null,
    recentSignatures: sigs.length,
    analyzedTransactions: analyzed,
    events,
  });
}

async function fetchWalletHistory(rpc: OnchainRpc, address: string, pct: number, config: OnchainConfig): Promise<WalletHistory> {
  const limit = config.clusters.signatureLimit;
  const sigs = await rpc.getSignatures(address, limit);
  const complete = sigs.length < limit;
  let firstSeen: number | null = null;
  let funder: string | null = null;
  let fundingSignature: string | null = null;
  if (complete && sigs.length > 0) {
    const oldest = sigs[sigs.length - 1];
    firstSeen = oldest.blockTime ? oldest.blockTime * 1000 : null;
    const tx = await rpc.getTransaction(oldest.signature);
    if (tx) {
      funder = findFunder(tx, address, config.clusters.minFundingSol);
      if (funder) fundingSignature = oldest.signature;
    }
  }
  return { address, pct, signatureCount: sigs.length, historyComplete: complete, firstSeen, funder, fundingSignature, signatures: sigs.map((s) => s.signature) };
}

/** For funders shared by several wallets, count their signatures (one page) to spot busy services / exchanges. */
async function checkSharedFunders(rpc: OnchainRpc, histories: WalletHistory[], config: OnchainConfig): Promise<void> {
  const counts = new Map<string, number>();
  for (const h of histories) if (h.funder) counts.set(h.funder, (counts.get(h.funder) ?? 0) + 1);
  const shared = [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, config.clusters.maxFundersChecked).map(([f]) => f);
  const activity = new Map<string, number | null>();
  for (const f of shared) {
    try {
      activity.set(f, (await rpc.getSignatures(f, config.clusters.busyFunderSignatures)).length);
    } catch {
      activity.set(f, null);
    }
  }
  for (const h of histories) h.funderSignatureCount = h.funder ? (activity.get(h.funder) ?? null) : null;
}

// ─── entry point ───────────────────────────────────────────────────────────

export async function collectOnchain(rpc: OnchainRpc, target: CollectTarget, config: OnchainConfig = ONCHAIN_CONFIG, now: () => number = Date.now): Promise<OnchainData> {
  const mintInfo = await attempt(() => fetchMint(rpc, target.mint));
  const mintData = mintInfo.status === "ok" ? mintInfo.value : null;

  let holderScan: HolderScan | null = null;
  const holders: Section<HoldersData> = mintData
    ? await attempt(async () => {
        holderScan = await fetchHolders(rpc, mintData, target.mint, config);
        return ok(holderScan.data);
      })
    : unavailable("dépend du compte mint (programme de token inconnu)");

  const owners: Section<Record<string, OwnerInfo>> =
    holders.status === "ok"
      ? await attempt(async () => ok(await fetchOwners(rpc, holders.value.top.map((h) => h.owner))))
      : unavailable("dépend de la liste des holders");
  const ownerMap = owners.status === "ok" ? owners.value : null;
  const isTechnical = (o: string) => classifyHolder(o, ownerMap?.[o], target.pairAddress).excluded;

  const creator = await attempt(() => findCreator(rpc, target, ownerMap, config));

  const creatorActivity: Section<CreatorActivity> =
    creator.status === "ok"
      ? await attempt(() => fetchCreatorActivity(rpc, creator.value.address, target.mint, mintData, holderScan, isTechnical, config))
      : notFound("deployment-associated wallet non identifié");

  let wallets: Section<WalletHistory[]>;
  if (holders.status !== "ok" || !ownerMap) {
    wallets = unavailable("dépend de la liste et de la classification des holders");
  } else {
    const picks = holders.value.top.filter((h) => !isTechnical(h.owner)).slice(0, config.clusters.wallets);
    wallets = await attempt(async () => {
      const histories = await Promise.all(picks.map((h) => fetchWalletHistory(rpc, h.owner, h.pctOfSupply, config)));
      await checkSharedFunders(rpc, histories, config);
      return ok(histories);
    });
  }

  return {
    mintAddress: target.mint,
    pairAddress: target.pairAddress,
    dexId: target.dexId,
    fetchedAt: now(),
    rpcUrl: rpc.url,
    mintInfo,
    holders,
    owners,
    creator,
    creatorActivity,
    wallets,
  };
}
