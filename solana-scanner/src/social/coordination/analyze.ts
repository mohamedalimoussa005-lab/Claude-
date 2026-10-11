/**
 * Orchestrator: from already-read transactions of one token to launch, funding, cluster and volume reports.
 * Pure function — same input, same output. Nothing is fetched here.
 */

import type { CoordinationConfig, Coverage, KnownEntity, NormalizedTx, SwapEvent } from "./model.ts";
import { DEFAULT_CONFIG, validateConfig } from "./model.ts";
import { QUOTE_DECIMALS, WSOL_MINT, entityMap } from "./entities.ts";
import { extractSwap, extractTokenTransfer } from "./normalize.ts";
import type { SwapExtraction, TokenTransfer } from "./normalize.ts";
import { analyzeLaunch } from "./launch.ts";
import type { LaunchReport } from "./launch.ts";
import { traceFunding } from "./funding.ts";
import type { FundingProvider, FundingReport } from "./funding.ts";
import { clusterCohort } from "./cluster.ts";
import type { ClusterReport } from "./cluster.ts";
import { analyzeWash } from "./washVolume.ts";
import type { WashReport } from "./washVolume.ts";

export interface CoordinationInput {
  mint: string;
  /** The token creator when known (counted apart from independent buyers). */
  creator: string | null;
  supplyRaw: bigint | null;
  /** Transactions of the token that were read, in any order, with the coverage of that reading. */
  txs: readonly NormalizedTx[];
  coverage: Coverage;
  /** Funding histories of wallets (cohort wallets and their funders). */
  provider: FundingProvider;
  /** Quote mints expected for the token (e.g. wSOL, USDC); omitted → inferred from each transaction. */
  quoteMints?: readonly string[];
  /** Decimals of the quote mint when it is not SOL/USDC/USDT, to express amounts in human units. */
  quoteDecimals?: number;
  /** Extra labelled addresses (exchanges, bridges, public bots) merged over the built-in program/tip list. */
  entities?: Readonly<Record<string, KnownEntity>>;
  cfg?: CoordinationConfig;
}

export interface CoordinationResult {
  mint: string;
  swaps: SwapEvent[];
  /** The quote mint all amounts in this result are expressed in (the one most swaps use). */
  quoteMint: string;
  /** Decimals of `quoteMint`, or null when unknown (amounts are then raw units). */
  quoteDecimals: number | null;
  transfers: TokenTransfer[];
  /** Transactions read but not turned into a swap or transfer, by reason. */
  skipped: Record<string, number>;
  launch: LaunchReport;
  funding: FundingReport;
  cluster: ClusterReport;
  wash: WashReport;
  coverage: Coverage;
  entities: ReadonlyMap<string, KnownEntity>;
  /** Every limitation that applies to the whole result. */
  limits: string[];
  /** True when only the oldest part of the listed transactions was read: later activity (exits, volume) is not seen. */
  scopeLimited: boolean;
}

export function analyzeCoordination(input: CoordinationInput): CoordinationResult {
  const cfg = input.cfg ?? DEFAULT_CONFIG;
  validateConfig(cfg);
  const entities = entityMap(input.entities);
  if (input.creator) entities.set(input.creator, { kind: "creator", label: "créateur du token" });

  const swaps: SwapEvent[] = [];
  const transfers: TokenTransfer[] = [];
  const skipped: Record<string, number> = {};
  const seen = new Set<string>();
  for (const tx of input.txs) {
    if (seen.has(tx.signature)) continue; // the same transaction may be listed by several addresses
    seen.add(tx.signature);
    const r: SwapExtraction = extractSwap(tx, input.mint, { quoteMints: input.quoteMints });
    if (r.swap) {
      swaps.push(r.swap);
      continue;
    }
    if (r.skipped === "no_dex_program") {
      const t = extractTokenTransfer(tx, input.mint);
      if (t) {
        transfers.push(t);
        continue;
      }
    }
    if (r.skipped && r.skipped !== "no_base_delta") skipped[r.skipped] = (skipped[r.skipped] ?? 0) + 1;
  }

  // all amounts of one result share one quote mint: the most used one; swaps priced in another are set aside
  const counts = new Map<string, number>();
  for (const s of swaps) if (s.quoteAmount > 0n) counts.set(s.quoteMint, (counts.get(s.quoteMint) ?? 0) + 1);
  const quoteMint = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? input.quoteMints?.[0] ?? WSOL_MINT;
  const other = swaps.filter((s) => s.quoteAmount > 0n && s.quoteMint !== quoteMint).length;
  const priced = swaps.filter((s) => s.quoteAmount === 0n || s.quoteMint === quoteMint).map((s) => (s.quoteAmount === 0n ? { ...s, quoteMint } : s));
  swaps.length = 0;
  swaps.push(...priced);
  if (other > 0) skipped.other_quote_mint = other;
  const quoteDecimals = QUOTE_DECIMALS[quoteMint] ?? input.quoteDecimals ?? null;

  const launch = analyzeLaunch({ mint: input.mint, swaps, creator: input.creator, entities, supplyRaw: input.supplyRaw, coverage: input.coverage, cfg });
  const funding = traceFunding({ cohort: launch.cohort.map((m) => m.wallet), provider: input.provider, entities, creator: input.creator, cfg });
  const cluster = clusterCohort({ cohort: launch.cohort, swaps, funding, transfers, supplyRaw: input.supplyRaw, cfg });
  const listed = input.coverage.signaturesRead;
  const read = input.coverage.transactionsRead + input.coverage.transactionsMissing;
  const scopeLimited = listed > read;
  const scopeNote = `analyse limitée aux ${input.coverage.transactionsRead} transactions les plus anciennes sur ${listed} listées: l'activité plus récente (sorties, volume) n'est pas vue`;
  const wash = analyzeWash({ swaps, transfers, entities, cfg, coverageNotes: [...launch.notes.filter((n) => n.startsWith("historique incomplet")), ...(scopeLimited ? [scopeNote] : [])] });

  const limits: string[] = [...launch.notes, ...funding.notes, ...cluster.notes, ...(scopeLimited ? [scopeNote] : [])];
  if (skipped.unattributed) limits.push(`${skipped.unattributed} transaction(s) avec mouvement du token non attribuable à un signataire (routeur ou programme intermédiaire)`);
  if (skipped.no_dex_program) limits.push(`${skipped.no_dex_program} transaction(s) déplaçant le token sans programme DEX connu et sans paire expéditeur/destinataire exacte: ni swap ni transfert classés`);
  if (skipped.other_quote_mint) limits.push(`${skipped.other_quote_mint} swap(s) cotés dans un autre token que ${quoteMint} écartés (les montants ne sont pas additionnables)`);
  if (skipped.failed) limits.push(`${skipped.failed} transaction(s) échouée(s) ignorée(s)`);
  limits.push("pseudonymat: des wallets distincts peuvent appartenir à la même personne, ou des wallets liés à des personnes différentes");
  limits.push("aucune conclusion de fraude ni de contrôle commun ne peut être tirée de ces seules mesures");
  return { mint: input.mint, swaps, quoteMint, quoteDecimals, transfers, skipped, launch, funding, cluster, wash, coverage: input.coverage, entities, limits, scopeLimited };
}
