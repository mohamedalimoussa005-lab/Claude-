/**
 * Token identity, authorities, supply, taxes, holders and the deployment-associated wallet (the scanner's existing
 * collector and rules are reused unchanged; only their FACTS are reported, never their scores).
 */

import { analyzeOnchain } from "../onchain/analyze.ts";
import type { OnchainAnalysis } from "../onchain/analyze.ts";
import { collectOnchain } from "../onchain/collect.ts";
import { ONCHAIN_CONFIG } from "../onchain/config.ts";
import type { OnchainConfig } from "../onchain/config.ts";
import type { OnchainData } from "../onchain/types.ts";
import { base64ToBytes } from "../social/depth/bytes.ts";
import { decodeMint } from "../social/depth/decode.ts";
import type { MintData } from "../social/depth/decode.ts";
import { feeAtEpoch } from "../social/depth/token2022.ts";
import { BudgetError } from "./meter.ts";
import type { ReadRpc } from "./meter.ts";
import type { ModeConfig } from "./modes.ts";
import type { Finding, ReportSection } from "./types.ts";
import { section } from "./types.ts";

export interface IdentityData {
  mint: string;
  tokenProgram: string | null;
  decimals: number | null;
  supplyRaw: string | null;
  supply: number | null;
  mintAuthority: string | null | "UNKNOWN";
  freezeAuthority: string | null | "UNKNOWN";
  permanentDelegate: string | null;
  transferHookProgram: string | null;
  transferFee: { olderBps: number; newerBps: number; newerEpoch: string; currentBps: number | null; currentMaxFeeRaw: string | null; epoch: string | null } | null;
  holders: { count: number; tokenAccounts: number; rawTop1: number; rawTop5: number; rawTop10: number; adjustedTop1: number | null; adjustedTop5: number | null; adjustedTop10: number | null; excluded: number } | null;
  existingRules: { redFlags: string[]; positives: string[]; unknowns: string[] } | null;
}

export interface CreatorData {
  address: string | null;
  method: string | null;
  evidence: string | null;
  solBalance: number | null;
  tokenPct: number | null;
  analyzedTransactions: number | null;
  events: { signature: string; time: number | null; kind: string; tokenDeltaPct: number; recipients: string[] }[];
}

export interface IdentityResult {
  identity: ReportSection<IdentityData>;
  creator: ReportSection<CreatorData>;
  onchain: OnchainData | null;
  analysis: OnchainAnalysis | null;
  mintData: MintData | null;
}

export interface IdentityDeps {
  collect?: typeof collectOnchain;
}

const pct = (n: number) => `${n.toFixed(2)} %`;

export function onchainConfigFor(mode: ModeConfig): OnchainConfig {
  return {
    ...ONCHAIN_CONFIG,
    creator: { ...ONCHAIN_CONFIG.creator, analyzeTransactions: mode.onchain.creatorTransactions, mintSignaturePages: mode.onchain.mintSignaturePages },
    clusters: { ...ONCHAIN_CONFIG.clusters, wallets: mode.onchain.holderWallets },
  };
}

export async function buildIdentity(
  rpc: ReadRpc,
  mint: string,
  target: { pairAddress: string | null; dexId: string | null; name: string | null; symbol: string | null },
  mode: ModeConfig,
  limit: (text: string) => void,
  deps: IdentityDeps = {},
): Promise<IdentityResult> {
  const findings: Finding[] = [];
  const unknowns: string[] = [];
  const limits: string[] = [];
  const idData: IdentityData = { mint, tokenProgram: null, decimals: null, supplyRaw: null, supply: null, mintAuthority: "UNKNOWN", freezeAuthority: "UNKNOWN", permanentDelegate: null, transferHookProgram: null, transferFee: null, holders: null, existingRules: null };

  // 1. the scanner's collector (mint, holders, creator, creator activity) — budgeted, partial results kept
  let onchain: OnchainData | null = null;
  let analysis: OnchainAnalysis | null = null;
  try {
    const cfg = onchainConfigFor(mode);
    onchain = await (deps.collect ?? collectOnchain)(rpc, { mint, pairAddress: target.pairAddress, dexId: target.dexId }, cfg);
    analysis = analyzeOnchain(onchain, cfg);
  } catch (e) {
    unknowns.push(`collecte on-chain impossible: ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof BudgetError) limit(e.message);
  }

  // 2. exact decoding of the mint account (Token-2022 fee schedule, delegate, hook)
  let mintData: MintData | null = null;
  try {
    const [acc] = await rpc.getMultipleAccounts([mint]);
    if (acc) {
      idData.tokenProgram = acc.owner;
      mintData = decodeMint(base64ToBytes(acc.data[0]));
    } else unknowns.push("compte mint introuvable");
  } catch (e) {
    unknowns.push(`lecture du compte mint impossible: ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof BudgetError) limit(e.message);
  }
  if (mintData) {
    idData.decimals = mintData.decimals;
    idData.supplyRaw = mintData.supply.toString();
    idData.supply = Number(mintData.supply) / 10 ** mintData.decimals;
    idData.mintAuthority = mintData.mintAuthority;
    idData.freezeAuthority = mintData.freezeAuthority;
    idData.permanentDelegate = mintData.permanentDelegate;
    idData.transferHookProgram = mintData.transferHookProgram;
    if (mintData.transferFee) {
      let epoch: bigint | null = null;
      try {
        const info = (await rpc.call("getEpochInfo", [])) as { epoch?: number };
        if (typeof info.epoch === "number") epoch = BigInt(info.epoch);
      } catch (e) {
        if (e instanceof BudgetError) limit(e.message);
      }
      const cur = epoch === null ? null : feeAtEpoch(mintData.transferFee, epoch);
      idData.transferFee = { olderBps: mintData.transferFee.olderBps, newerBps: mintData.transferFee.newerBps, newerEpoch: mintData.transferFee.newerEpoch.toString(), currentBps: cur?.bps ?? null, currentMaxFeeRaw: cur?.maximumFee.toString() ?? null, epoch: epoch?.toString() ?? null };
    }
  } else if (analysis) {
    // fall back to the collector's own reading
    if (onchain?.mintInfo.status === "ok") {
      const m = onchain.mintInfo.value;
      idData.tokenProgram = m.program;
      idData.decimals = m.decimals;
      idData.supplyRaw = m.supplyRaw;
      idData.supply = Number(m.supplyRaw) / 10 ** m.decimals;
      idData.mintAuthority = m.mintAuthority;
      idData.freezeAuthority = m.freezeAuthority;
    }
  }

  // findings
  const name = [target.name, target.symbol ? `(${target.symbol})` : null].filter(Boolean).join(" ");
  if (name) findings.push({ level: "INDICE", text: `Nom déclaré par DEX Screener: ${name}.` });
  if (idData.supply !== null) {
    findings.push({ level: "FAIT", text: `Supply ${idData.supply.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} (${idData.decimals} décimales), programme ${idData.tokenProgram === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" ? "Token-2022" : idData.tokenProgram === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" ? "SPL Token" : (idData.tokenProgram ?? "inconnu")}.`, anchors: [mint] });
  } else unknowns.push("supply et décimales");
  const auth = (label: string, v: string | null | "UNKNOWN") => {
    if (v === "UNKNOWN") unknowns.push(`autorité ${label}`);
    else if (v === null) findings.push({ level: "FAIT", text: `Autorité ${label}: révoquée (aucune adresse ne peut ${label === "de mint" ? "créer de nouveaux tokens" : "geler des comptes"}).`, anchors: [mint] });
    else findings.push({ level: "FAIT", text: `Autorité ${label}: ACTIVE (${v}).`, anchors: [mint, v] });
  };
  auth("de mint", idData.mintAuthority);
  auth("de gel", idData.freezeAuthority);
  if (idData.permanentDelegate) findings.push({ level: "FAIT", text: `Token-2022 « délégué permanent » actif (${idData.permanentDelegate}): cette adresse peut déplacer ou brûler les tokens de n'importe quel détenteur.`, anchors: [idData.permanentDelegate] });
  if (idData.transferHookProgram) findings.push({ level: "FAIT", text: `Token-2022 « transfer hook » actif (programme ${idData.transferHookProgram}): un programme externe est appelé à chaque transfert et peut le bloquer ou le taxer; son effet n'est pas calculé ici.`, anchors: [idData.transferHookProgram] });
  if (idData.transferFee) {
    const t = idData.transferFee;
    findings.push({ level: "FAIT", text: `Token-2022 frais de transfert: ${t.currentBps === null ? `${t.olderBps / 100} % puis ${t.newerBps / 100} % à partir de l'époque ${t.newerEpoch} (époque actuelle non lue)` : `${t.currentBps / 100} % actuellement (plafond ${t.currentMaxFeeRaw} unités brutes)`}.`, anchors: [mint] });
  } else if (mintData && idData.tokenProgram === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") {
    findings.push({ level: "FAIT", text: "Programme SPL Token classique: aucune taxe de transfert native (pas d'extension Token-2022).", anchors: [mint] });
  } else if (mintData && !mintData.permanentDelegate && !mintData.transferHookProgram) {
    findings.push({ level: "FAIT", text: "Token-2022 sans extension de frais de transfert.", anchors: [mint] });
  }
  limits.push("une taxe appliquée par un programme tiers (hook) ou par la logique du pool n'est pas détectée ici; les frais de pool sont lus dans la section Liquidité");

  // holders
  if (analysis?.holders) {
    const h = analysis.holders;
    idData.holders = { count: h.holderCount, tokenAccounts: h.tokenAccounts, rawTop1: h.raw.top1, rawTop5: h.raw.top5, rawTop10: h.raw.top10, adjustedTop1: h.adjusted?.top1 ?? null, adjustedTop5: h.adjusted?.top5 ?? null, adjustedTop10: h.adjusted?.top10 ?? null, excluded: h.excluded.length };
    findings.push({ level: "FAIT", text: `${h.holderCount} détenteurs (${h.tokenAccounts} comptes). Concentration brute top 1/5/10: ${pct(h.raw.top1)} / ${pct(h.raw.top5)} / ${pct(h.raw.top10)}${h.adjusted ? `; hors comptes techniques (pools, burn…) ${pct(h.adjusted.top1)} / ${pct(h.adjusted.top5)} / ${pct(h.adjusted.top10)}` : "; ajustement des comptes techniques impossible"}.`, anchors: [mint] });
  } else {
    unknowns.push(onchain?.holders.status === "unavailable" ? `détenteurs (${onchain.holders.error})` : "détenteurs");
  }
  if (analysis) {
    idData.existingRules = { redFlags: analysis.redFlags, positives: analysis.positives, unknowns: analysis.unknowns };
    for (const r of analysis.redFlags) findings.push({ level: "INDICE", text: `Règle existante du scanner: ${r}` });
    for (const u of analysis.unknowns) if (!unknowns.includes(u)) unknowns.push(u);
  }

  const identity = section<IdentityData>("Identité du token", { status: idData.supply !== null ? (unknowns.length ? "partial" : "ok") : "unknown", data: idData, findings, unknowns, limits });

  // creator
  const cFindings: Finding[] = [];
  const cUnknowns: string[] = [];
  const cData: CreatorData = { address: null, method: null, evidence: null, solBalance: null, tokenPct: null, analyzedTransactions: null, events: [] };
  if (onchain?.creator.status === "ok") {
    const c = onchain.creator.value;
    cData.address = c.address;
    cData.method = c.method;
    cData.evidence = c.evidence;
    cFindings.push({ level: "INDICE", text: `Wallet associé au déploiement: ${c.address} (méthode: ${c.method}). Ce n'est pas prouvé comme étant le développeur réel. ${c.evidence}`, anchors: [c.address] });
    if (idData.mintAuthority !== "UNKNOWN" && idData.mintAuthority === c.address) cFindings.push({ level: "FAIT", text: "Ce wallet est aussi l'autorité de mint ACTIVE.", anchors: [c.address] });
    if (idData.freezeAuthority !== "UNKNOWN" && idData.freezeAuthority === c.address) cFindings.push({ level: "FAIT", text: "Ce wallet est aussi l'autorité de gel ACTIVE.", anchors: [c.address] });
  } else cUnknowns.push(onchain?.creator.status === "unavailable" ? `créateur (${onchain.creator.error})` : onchain?.creator.status === "not_found" ? `créateur: ${onchain.creator.reason}` : "créateur");
  if (onchain?.creatorActivity.status === "ok") {
    const a = onchain.creatorActivity.value;
    cData.solBalance = a.solBalance;
    cData.tokenPct = a.tokenPct;
    cData.analyzedTransactions = a.analyzedTransactions;
    cData.events = a.events.map((e) => ({ signature: e.signature, time: e.time, kind: e.kind, tokenDeltaPct: e.tokenDeltaPct, recipients: e.recipients }));
    cFindings.push({ level: "FAIT", text: `Solde du wallet: ${a.solBalance.toFixed(3)} SOL; détient ${a.tokenPct === null ? "INCONNU" : pct(a.tokenPct)} de l'offre; ${a.analyzedTransactions} transaction(s) récente(s) analysée(s) sur ${a.recentSignatures} signature(s) lues.`, anchors: [cData.address ?? ""] });
    for (const ev of a.events.slice(0, 6)) cFindings.push({ level: "FAIT", text: `${ev.kind === "sell" ? "Vente" : ev.kind === "transfer" ? "Transfert sortant" : ev.kind === "receive" ? "Réception" : "Opération"} de ${Math.abs(ev.tokenDeltaPct).toFixed(2)} % de l'offre${ev.recipients.length ? ` vers ${ev.recipients.length} wallet(s)` : ""}.`, anchors: [ev.signature] });
  } else if (cData.address) cUnknowns.push("activité récente du wallet associé au déploiement");
  const creator = section<CreatorData>("Créateur et autorités", { status: cData.address ? (cUnknowns.length ? "partial" : "ok") : "unknown", data: cData, findings: cFindings, unknowns: cUnknowns, limits: ["le créateur est une heuristique (courbe pump.fun, pool PumpSwap, premier signataire): jamais une identité"] });
  return { identity, creator, onchain, analysis, mintData };
}
