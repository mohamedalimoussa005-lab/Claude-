/**
 * DETECTIVE orchestrator: one token address → one report (+ evidence ledger). Read-only: no trade, no write,
 * no paid service. All reads go through the budgeted client; every cap that is hit is written in the report.
 */

import { EvidenceLedger } from "../social/ledger.ts";
import { recordDepthEvidence } from "../social/depth/evidence.ts";
import type { collectOnchain } from "../onchain/collect.ts";
import { buildIdentity } from "./identity.ts";
import { buildLiquidity } from "./liquidity.ts";
import { budgeted, Meter } from "./meter.ts";
import type { ReadRpc } from "./meter.ts";
import { withMode } from "./modes.ts";
import type { ModeConfig } from "./modes.ts";
import { renderMarkdown } from "./render.ts";
import { resolveToken } from "./resolve.ts";
import type { DexPort, Resolution } from "./resolve.ts";
import { buildSocial } from "./social.ts";
import { buildSynthesis } from "./synthesis.ts";
import { buildLaunchSections } from "./launch.ts";
import { DISCLAIMERS, section } from "./types.ts";
import type { DetectiveReport, ModeName, ReportSection } from "./types.ts";

export interface RunOptions {
  mint: string;
  mode: ModeName;
  /** Overrides of the mode's numbers (call budget, caps…). */
  overrides?: Parameters<typeof withMode>[1];
}

export interface RunDeps {
  dex: DexPort;
  rpc: ReadRpc;
  /** Create it with the mode's budget and pass `meter.onRequest` to the RPC client to count HTTP attempts. */
  meter?: Meter;
  now?: () => number;
  collect?: typeof collectOnchain;
  /** Sleep used between paged reads (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

export interface RunResult {
  report: DetectiveReport;
  ledger: EvidenceLedger;
  markdown: string;
  mode: ModeConfig;
}

export function newMeter(mode: ModeConfig, now: () => number = Date.now): Meter {
  return new Meter(mode.name, mode.maxCalls, mode.maxMs, now);
}

export async function runDetective(opts: RunOptions, deps: RunDeps): Promise<RunResult> {
  const mode = withMode(opts.mode, opts.overrides);
  const now = deps.now ?? Date.now;
  const meter = deps.meter ?? newMeter(mode, now);
  const rpc = budgeted(deps.rpc, meter);
  const ledger = new EvidenceLedger();
  const observedAt = new Date(now()).toISOString();
  const limit = (t: string) => meter.limit(t);

  // 1. token → pools (DEX Screener, public)
  let res: Resolution;
  try {
    res = await resolveToken(deps.dex, opts.mint);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("adresse de token invalide")) throw e;
    res = { mint: opts.mint, pools: [], primary: null, profile: { websites: [], socials: [], imageUrl: null }, notes: [`DEX Screener indisponible: ${e instanceof Error ? e.message : String(e)}`] };
    limit("DEX Screener indisponible");
  }

  // 2. identity, authorities, taxes, holders, creator
  const idr = await buildIdentity(rpc, opts.mint, { pairAddress: res.primary?.pairAddress ?? null, dexId: res.primary?.dexId ?? null, name: res.primary?.baseName ?? null, symbol: res.primary?.baseSymbol ?? null }, mode, limit, { collect: deps.collect });
  for (const n of res.notes) idr.identity.limits.push(n);

  // 3. liquidity + exit simulations (5B)
  const liq = await buildLiquidity(rpc, res, limit, now);

  // 4. launch, first buyers, funding, coordination, repetitive volume (5C/5D)
  const launch = await buildLaunchSections({ rpc, mint: opts.mint, res, mode, meter, ledger, observedAt, creator: idr.creator.data?.address ?? null, supplyRaw: idr.identity.data?.supplyRaw ?? null, sleep: deps.sleep });

  // 5. social links
  const social = buildSocial(res.profile, res.primary !== null);

  // 6. evidence ledger
  if (idr.identity.data && idr.identity.data.supplyRaw !== null) {
    ledger.add({
      mint: opts.mint,
      type: "mint_state",
      source: "solana_rpc",
      status: "FACT",
      derivation: "observed",
      summary: `État du mint ${opts.mint}: supply, décimales et autorités`,
      facts: [
        { key: "supplyRaw", value: idr.identity.data.supplyRaw },
        { key: "decimals", value: idr.identity.data.decimals },
        { key: "mintAuthority", value: idr.identity.data.mintAuthority === "UNKNOWN" ? null : idr.identity.data.mintAuthority },
        { key: "freezeAuthority", value: idr.identity.data.freezeAuthority === "UNKNOWN" ? null : idr.identity.data.freezeAuthority },
        { key: "permanentDelegate", value: idr.identity.data.permanentDelegate },
        { key: "transferHookProgram", value: idr.identity.data.transferHookProgram },
        { key: "transferFeeBpsNow", value: idr.identity.data.transferFee?.currentBps ?? null },
      ],
      observedAt,
      addresses: [opts.mint],
      limits: ["lecture instantanée du compte mint"],
    });
  }
  if (res.primary) {
    ledger.add({
      mint: opts.mint,
      type: "dex_pair",
      source: "dexscreener",
      status: "FACT",
      derivation: "observed",
      summary: `DEX Screener liste le pool ${res.primary.pairAddress} (${res.primary.dexId ?? "dex inconnu"}) pour ce token`,
      facts: [
        { key: "liquidityUsdDeclared", value: res.primary.liquidityUsd },
        { key: "volumeH24Declared", value: res.primary.volumeH24 },
        { key: "priceUsdDeclared", value: res.primary.priceUsd },
        { key: "marketCapDeclared", value: res.primary.marketCap },
      ],
      observedAt,
      url: res.primary.url ?? `https://dexscreener.com/solana/${res.primary.pairAddress}`,
      addresses: [res.primary.pairAddress],
      limits: ["chiffres agrégés et déclarés par un tiers (DEX Screener), non vérifiés on-chain"],
    });
  }
  if (liq.built && liq.depth) {
    try {
      recordDepthEvidence({ ledger, mint: opts.mint, report: liq.depth, built: liq.built, observedAt, slot: liq.snapshot?.slot ?? null });
    } catch (e) {
      liq.liquidity.limits.push(`preuve de profondeur non enregistrée au ledger: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const rec of launch.record) rec(ledger);

  const evidence = buildEvidenceSection(ledger, launch.evidenceUnknowns);
  const sections = { identity: idr.identity, creator: idr.creator, firstBuyers: launch.firstBuyers, funding: launch.funding, liquidity: liq.liquidity, exitSimulations: liq.exits, repetitive: launch.repetitive, social, evidence, synthesis: section("Synthèse") };
  sections.synthesis = buildSynthesis(sections, meter.report());
  const report: DetectiveReport = { schema: "detective-report/1", mint: opts.mint, generatedAt: observedAt, mode: opts.mode, budget: meter.report(), sections, hypothesesEnabled: false, disclaimers: [...DISCLAIMERS] };
  return { report, ledger, markdown: renderMarkdown(report), mode };
}

function buildEvidenceSection(ledger: EvidenceLedger, extraUnknowns: string[]): ReportSection {
  const all = ledger.all();
  const by: Record<string, number> = {};
  for (const e of all) by[e.status] = (by[e.status] ?? 0) + 1;
  const withSig = all.filter((e) => e.signature).length;
  const gaps = all.filter((e) => e.type === "data_gap");
  const findings = [
    { level: "FAIT" as const, text: `Grand livre de preuves: ${all.length} entrée(s) (${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(", ") || "vide"}); ${withSig} ancrée(s) sur une signature de transaction. Écrit dans ledger.json avec le rapport.` },
  ];
  for (const g of gaps.slice(0, 12)) findings.push({ level: "FAIT" as const, text: `Lacune enregistrée: ${g.summary} — manque: ${g.missing.join("; ")}.` });
  return section("Preuves et données inconnues", { status: all.length ? "ok" : "unknown", data: { entries: all.length, byStatus: by, anchoredOnSignature: withSig, gaps: gaps.length }, findings, unknowns: extraUnknowns, limits: ["les statuts HYPOTHÈSE n'existent pas dans ce produit (désactivés)"] });
}
