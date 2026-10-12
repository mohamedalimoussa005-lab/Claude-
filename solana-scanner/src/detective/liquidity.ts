/**
 * Live reading of a pool supported by the 5B depth engine, then buy / sell / round-trip simulations.
 * Everything unsupported is reported as NON SIMULÉ with its reason. A simulation is a calculation on a frozen
 * snapshot, never a guarantee of execution.
 */

import { base64ToBytes } from "../social/depth/bytes.ts";
import { decodeClmmPool, decodeCpmmPool, decodePumpPool } from "../social/depth/decode.ts";
import { analyzeDepth } from "../social/depth/engine.ts";
import type { DepthPoint, DepthReport, SizedTrade } from "../social/depth/engine.ts";
import { buildClmmVenue, buildCpmmVenue, buildPumpVenue } from "../social/depth/snapshot.ts";
import type { AccountMap, BuiltVenue } from "../social/depth/snapshot.ts";
import { BudgetError } from "./meter.ts";
import type { ReadRpc } from "./meter.ts";
import { findProgramAddress, base58Decode, utf8 } from "./pda.ts";
import { classifyVenue } from "./resolve.ts";
import type { PoolInfo, Resolution, VenueClass } from "./resolve.ts";
import type { Finding, ReportSection } from "./types.ts";
import { section } from "./types.ts";

const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const PUMP_FEE_PROGRAM = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
const PUMP_CURVE = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";

export interface LiquidityData {
  pool: { address: string; dexId: string | null; url: string | null } | null;
  venue: { supported: boolean; kind: string | null; program: string | null; programName: string | null; reason: string | null };
  declaredByDexScreener: { liquidityUsd: number | null; volumeH24: number | null; buysH24: number | null; sellsH24: number | null; marketCap: number | null; priceUsd: number | null } | null;
  snapshot: { slot: number | null; epoch: string | null; observedAt: string } | null;
  quote: { mint: string | null; symbol: string | null; usdPerQuote: number | null; source: string } | null;
  depth: DepthReport | null;
  /** Facts read from the pool accounts (reserves, fees tracked…). */
  observed: Record<string, string | number | boolean | null> | null;
}

export interface LiquidityResult {
  liquidity: ReportSection<LiquidityData>;
  exits: ReportSection<{ depth: DepthReport | null; reason: string | null }>;
  built: BuiltVenue | null;
  depth: DepthReport | null;
  snapshot: { slot: number | null; observedAt: string } | null;
}

export const DISCLAIMER_FR = "Simulation sur un état figé du pool: ni une cotation ni une garantie d'exécution. Ignore frais de priorité, pourboires, MEV, autres pools, restrictions du programme de token (gel, hooks) et tout changement après l'instantané.";

/** French wording for the engine's fixed English phrases (numbers and addresses are untouched). */
const FR: [RegExp, string][] = [
  [/^buy \$(\d+)$/, "achat de $1 $"],
  [/^sell (\d+)% of supply$/, "vente de $1 % de l'offre"],
  [/the pool runs out of liquidity first/g, "la liquidité s'épuise avant"],
  [/no initialized tick ahead after consuming (\d+) of (\d+)/g, "plus aucun tick initialisé après avoir consommé $1 sur $2"],
  [/liquidity_exhausted/g, "liquidité épuisée"],
  [/insufficient_real_reserves/g, "réserves réelles insuffisantes"],
  [/beyond_loaded_data/g, "au-delà des données chargées"],
  [/trade fee ([\d.]+) % \((.*?)\) charged on the input token/g, "frais de trade $1 % ($2) prélevés sur le token d'entrée"],
  [/trade fee ([\d.]+) % \((.*?)\) charged on the output token/g, "frais de trade $1 % ($2) prélevés sur le token de sortie"],
  [/trade fee ([\d.]+) % \(ceil\) on the input/g, "frais de trade $1 % (arrondi supérieur) sur l'entrée"],
  [/creator fee ([\d.]+) %/g, "frais du créateur $1 %"],
  [/protocol/g, "protocole"],
  [/creator/g, "créateur"],
  [/market-cap tier/g, "palier de capitalisation"],
  [/market cap/g, "capitalisation"],
  [/boosted pool: (\d+) raw quote units of virtual reserves are priced but cannot be paid out/g, "pool « boosté »: $1 unités brutes de réserves virtuelles entrent dans le prix mais ne peuvent pas être payées"],
  [/Token-2022 transfer fee: base none, quote none/g, "frais de transfert Token-2022: aucun"],
  [/Token-2022 transfer fee: /g, "frais de transfert Token-2022: "],
  [/\bbase\b/g, "base"],
  [/liquidity changes only at the loaded initialized ticks\./g, "la liquidité ne change qu'aux ticks initialisés chargés."],
  [/pool state frozen at the snapshot slot\./g, "état du pool figé au slot de l'instantané."],
  [/no concurrent trades, no slippage limit, no priority fee or tip\./g, "pas de transactions concurrentes, pas de limite de slippage, ni frais de priorité ni pourboire."],
  [/swaps are disabled in the pool status/g, "les swaps sont désactivés dans l'état du pool"],
  [/dynamic fees are configured on this pool \(not simulated\)/g, "frais dynamiques configurés sur ce pool (non simulés)"],
];
export const fr = (t: string): string => FR.reduce((acc, [re, rep]) => acc.replace(re, rep), t);

const usd = (n: number | null | undefined): string => (n === null || n === undefined ? "n/a" : `${n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString("fr-FR")} $`);
const fmtPct = (n: number | null | undefined, d = 2): string => (n === null || n === undefined ? "n/a" : `${n.toFixed(d)} %`);

async function accountsOf(rpc: ReadRpc, addrs: string[]): Promise<AccountMap> {
  const uniq = [...new Set(addrs)];
  const res = await rpc.getMultipleAccounts(uniq);
  const out: AccountMap = {};
  uniq.forEach((a, i) => {
    const r = res[i];
    out[a] = r ? { owner: r.owner, data: r.data[0] } : null;
  });
  return out;
}

function declared(p: PoolInfo): LiquidityData["declaredByDexScreener"] {
  return { liquidityUsd: p.liquidityUsd, volumeH24: p.volumeH24, buysH24: p.buysH24, sellsH24: p.sellsH24, marketCap: p.marketCap, priceUsd: p.priceUsd };
}

function unsupportedResult(res: Resolution, v: VenueClass | null, reason: string, observedAt: string): LiquidityResult {
  const p = res.primary;
  const findings: Finding[] = [];
  if (p) findings.push({ level: "INDICE", text: `Liquidité déclarée par DEX Screener (tiers, non vérifiée): ${usd(p.liquidityUsd)}; volume 24 h ${usd(p.volumeH24)}; ${p.buysH24 ?? "?"} achats / ${p.sellsH24 ?? "?"} ventes sur 24 h.`, anchors: [p.pairAddress] });
  findings.push({ level: "NON SIMULÉ", text: `Profondeur d'achat et de vente: NON SIMULÉE — ${reason}.` });
  const data: LiquidityData = { pool: p ? { address: p.pairAddress, dexId: p.dexId, url: p.url } : null, venue: { supported: false, kind: null, program: v && !v.supported ? v.program : null, programName: v && !v.supported ? v.programName : null, reason }, declaredByDexScreener: p ? declared(p) : null, snapshot: { slot: null, epoch: null, observedAt }, quote: null, depth: null, observed: null };
  return {
    liquidity: section("Liquidité réelle", { status: "unsupported", data, findings, unknowns: ["profondeur réelle d'achat et de vente", "frais exacts du pool"], limits: [reason] }),
    exits: section("Simulations de sortie", { status: "unsupported", data: { depth: null, reason }, findings: [{ level: "NON SIMULÉ", text: `Aucune simulation de vente (achats, ventes de 1 % et 5 % de l'offre, aller-retour): ${reason}.` }], unknowns: ["capacité réelle de sortie"], limits: [reason] }),
    built: null,
    depth: null,
    snapshot: null,
  };
}

export async function buildLiquidity(rpc: ReadRpc, res: Resolution, limit: (t: string) => void, now: () => number = Date.now): Promise<LiquidityResult> {
  const observedAt = new Date(now()).toISOString();
  const p = res.primary;
  if (!p) return unsupportedResult(res, null, "aucun pool listé par DEX Screener pour ce token", observedAt);
  try {
    // 1. the pool account decides the venue
    const poolAcc = (await accountsOf(rpc, [p.pairAddress]))[p.pairAddress];
    const venue = classifyVenue(poolAcc?.owner ?? null, p.dexId);
    if (!venue.supported) return unsupportedResult(res, venue, venue.reason, observedAt);
    const poolBytes = base64ToBytes(poolAcc!.data);

    // 2. dependent accounts
    let need: string[] = [];
    let ticks: string[] = [];
    let pumpExtra: { globalConfig: string; feeConfig: string; canonicalCreator: string } | null = null;
    if (venue.kind === "pumpswap") {
      const pool = decodePumpPool(poolBytes);
      const globalConfig = findProgramAddress([utf8("global_config")], PUMP_AMM);
      const feeConfig = findProgramAddress([utf8("fee_config"), base58Decode(PUMP_AMM)], PUMP_FEE_PROGRAM);
      pumpExtra = { globalConfig, feeConfig, canonicalCreator: findProgramAddress([utf8("pool-authority"), base58Decode(pool.baseMint)], PUMP_CURVE) };
      need = [pool.baseVault, pool.quoteVault, pool.baseMint, pool.quoteMint, globalConfig, feeConfig];
    } else if (venue.kind === "cpmm") {
      const pool = decodeCpmmPool(poolBytes);
      need = [pool.ammConfig, pool.vault0, pool.vault1, pool.mint0, pool.mint1];
    } else {
      const pool = decodeClmmPool(poolBytes);
      need = [pool.ammConfig, pool.mint0, pool.mint1];
      const arrays = (await rpc.call("getProgramAccounts", [CLMM_PROGRAM, { encoding: "base64", filters: [{ dataSize: 10240 }, { memcmp: { offset: 8, bytes: p.pairAddress } }] }])) as { account: { data: [string, string] } }[];
      ticks = arrays.map((a) => a.account.data[0]);
    }
    const accounts: AccountMap = { ...(await accountsOf(rpc, need)), [p.pairAddress]: poolAcc };
    const info = (await rpc.call("getEpochInfo", [])) as { epoch?: number; absoluteSlot?: number };
    if (typeof info.epoch !== "number") throw new Error("époque courante illisible (getEpochInfo)");
    const epoch = BigInt(info.epoch);
    const slot = typeof info.absoluteSlot === "number" ? info.absoluteSlot : null;

    // 3. venue + simulations
    const built: BuiltVenue =
      venue.kind === "pumpswap"
        ? buildPumpVenue({ poolAddress: p.pairAddress, accounts, globalConfigAddress: pumpExtra!.globalConfig, feeConfigAddress: pumpExtra!.feeConfig, canonicalCreator: pumpExtra!.canonicalCreator, epoch })
        : venue.kind === "cpmm"
          ? buildCpmmVenue({ poolAddress: p.pairAddress, baseMint: res.mint, accounts, epoch })
          : buildClmmVenue({ poolAddress: p.pairAddress, baseMint: res.mint, accounts, tickArrays: ticks, ticksComplete: true, epoch });
    const quoteSource = p.usdPerQuote === null ? "aucun prix du token de cotation (montants en USD indisponibles)" : `DEX Screener priceUsd / priceNative (${p.quoteSymbol ?? "token de cotation"})`;
    const quoteMismatch = p.quoteMint !== null && p.quoteMint !== built.venue.info.quoteMint;
    const depth = analyzeDepth({ venue: built.venue, quote: { usdPerQuote: quoteMismatch ? null : p.usdPerQuote, source: quoteMismatch ? "token de cotation différent de celui de DEX Screener: USD indisponibles" : quoteSource }, baseSupply: built.baseSupply });
    return assemble(p, venue, built, depth, { slot, epoch: epoch.toString(), observedAt }, quoteSource);
  } catch (e) {
    if (e instanceof BudgetError) limit(e.message);
    const msg = e instanceof Error ? e.message : String(e);
    return unsupportedResult(res, null, `lecture ou simulation du pool impossible (${msg})`, observedAt);
  }
}

function pointLine(side: "ask" | "bid", d: DepthPoint): string {
  const lvl = String(d.impactBps / 100).replace(".", ",");
  if (side === "ask") return d.reached ? `+${lvl} % de prix: ${usd(d.input?.usd)} d'achats (reçoit ${usd(d.output?.usd)} de tokens)` : `+${lvl} % de prix: non atteignable (${fr(d.note ?? "liquidité épuisée")})`;
  return d.reached ? `−${lvl} % de prix: vendre ${usd(d.input?.usd)} de tokens (reçoit ${usd(d.output?.usd)})` : `−${lvl} % de prix: non atteignable — au plus ${usd(d.input?.usd)} de tokens vendables pour ${usd(d.output?.usd)} (${fr(d.note ?? "liquidité épuisée")})`;
}

function tradeLine(t: SizedTrade): string {
  if (t.ok) return `${fr(t.label)}: reçoit ${usd(t.amountOut?.usd)} pour ${usd(t.amountIn?.usd)}; impact d'exécution ${fmtPct(t.executionImpactPct)}`;
  return `${fr(t.label)}: IMPOSSIBLE (${fr(String(t.reason))}${t.detail ? `: ${fr(t.detail)}` : ""})${t.capacity ? `; capacité maximale ${usd(t.capacity.output.usd)}` : ""}`;
}

function assemble(p: PoolInfo, venue: Extract<VenueClass, { supported: true }>, built: BuiltVenue, depth: DepthReport, snap: { slot: number | null; epoch: string; observedAt: string }, quoteSource: string): LiquidityResult {
  const exact = depth.info.formulaAssurance === "program_source" && depth.complete;
  const lvl: "FAIT" | "INDICE" = exact ? "FAIT" : "INDICE";
  const findings: Finding[] = [];
  findings.push({ level: "FAIT", text: `Pool analysé: ${venue.programName} ${p.pairAddress} (état lu au slot ≈ ${snap.slot ?? "inconnu"}, époque ${snap.epoch}).`, anchors: [p.pairAddress] });
  for (const f of depth.info.fees) findings.push({ level: "FAIT", text: `Frais: ${fr(f)}.`, anchors: [p.pairAddress] });
  if (depth.info.transferTaxBps.base || depth.info.transferTaxBps.quote) findings.push({ level: "FAIT", text: `Taxe de transfert Token-2022 prise en compte: base ${depth.info.transferTaxBps.base / 100} %, cotation ${depth.info.transferTaxBps.quote / 100} %.` });
  findings.push({ level: "INDICE", text: `Liquidité déclarée par DEX Screener (tiers): ${usd(p.liquidityUsd)}; volume 24 h ${usd(p.volumeH24)}. Ces chiffres ne sont pas la liquidité réellement exécutable ci-dessous.`, anchors: [p.pairAddress] });
  for (const a of depth.info.assumptions) findings.push({ level: "INDICE", text: `Hypothèse du calcul: ${fr(a)}.` });
  for (const u of depth.info.unsupported) findings.push({ level: "NON SIMULÉ", text: `Fonction du pool non simulée: ${fr(u)}.` });
  if (!exact) findings.push({ level: "INDICE", text: depth.info.formulaAssurance === "program_source" ? "Résultats incomplets (données ou fonctions manquantes): lire comme des estimations." : "Le code du programme n'est pas public: formules du SDK officiel, reproduites sur des swaps réels mais non garanties; résultats à lire comme des indices." });
  for (const d of depth.ask) findings.push({ level: lvl, text: `Profondeur d'achat — ${pointLine("ask", d)}.`, anchors: [p.pairAddress] });
  for (const d of depth.bid) findings.push({ level: lvl, text: `Profondeur de vente — ${pointLine("bid", d)}.`, anchors: [p.pairAddress] });
  if (depth.exitToEntryRatio1Pct !== null) findings.push({ level: lvl, text: `Rapport sortie/entrée à ±1 %: ${depth.exitToEntryRatio1Pct.toPrecision(3)} (1 = symétrique, proche de 0 = pool à sens unique).` });
  const quote = { mint: built.venue.info.quoteMint, symbol: p.quoteSymbol, usdPerQuote: depth.quote.usdPerQuote, source: depth.quote.source };
  const liqData: LiquidityData = { pool: { address: p.pairAddress, dexId: p.dexId, url: p.url }, venue: { supported: true, kind: venue.kind, program: venue.program, programName: venue.programName, reason: null }, declaredByDexScreener: declared(p), snapshot: { slot: snap.slot, epoch: snap.epoch, observedAt: snap.observedAt }, quote, depth, observed: built.observed };
  void quoteSource;

  const exFindings: Finding[] = [{ level: "INDICE", text: DISCLAIMER_FR }];
  for (const t of depth.buys) exFindings.push({ level: lvl, text: `Achat — ${tradeLine(t)}.` });
  for (const t of depth.supplySells) exFindings.push({ level: lvl, text: `Vente — ${tradeLine(t)}.` });
  for (const r of depth.roundTrips) exFindings.push({ level: lvl, text: r.ok ? `Aller-retour immédiat de ${usd(r.usd)}: récupère ${usd(r.quoteBack?.usd)}, perte ${fmtPct(r.lossPct)} (frais et taxes inclus).` : `Aller-retour de ${usd(r.usd)}: ${fr(r.note ?? "impossible")}${r.lossPct !== null ? ` (perte ${fmtPct(r.lossPct)})` : ""}.` });
  return {
    liquidity: section("Liquidité réelle", { status: depth.complete ? "ok" : "partial", data: liqData, findings, unknowns: depth.complete ? [] : ["une partie de la liquidité ou des frais n'a pas pu être simulée"], limits: ["instantané unique: l'état du pool change à chaque transaction", "les autres pools du token ne sont pas inclus", "priorité, pourboires, MEV et restrictions de compte (gel, hooks) ne sont pas modélisés"] }),
    exits: section("Simulations de sortie", { status: depth.complete ? "ok" : "partial", data: { depth, reason: null }, findings: exFindings, unknowns: [], limits: [DISCLAIMER_FR] }),
    built,
    depth,
    snapshot: { slot: snap.slot, observedAt: snap.observedAt },
  };
}
