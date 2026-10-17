import type { Ledger, LedgerEntry } from "../ledger/types.ts";
import type { PnlResult } from "../pnl/types.ts";
import { ref } from "./window.ts";
import type { OrphanCategory, OrphanGroup, OrphanSale, Orphans, SameSlotCase } from "./types.ts";

interface Move {
  entry: LedgerEntry;
  mint: string;
  /** signed raw: + acquisition, − disposal */
  raw: bigint;
  decimals: number;
  what: SameSlotCase["sequence"][number]["what"];
}

function movesOf(e: LedgerEntry): Move[] {
  if (e.kind === "trade") return [{ entry: e, mint: e.mint, raw: e.side === "buy" ? BigInt(e.tokenRaw) : -BigInt(e.tokenRaw), decimals: e.decimals, what: e.side }];
  if (e.kind === "transfer") return [{ entry: e, mint: e.mint, raw: e.direction === "in" ? BigInt(e.tokenRaw) : -BigInt(e.tokenRaw), decimals: e.decimals, what: e.direction === "in" ? "transfer_in" : "transfer_out" }];
  return e.legs.map((l) => ({ entry: e, mint: l.mint, raw: BigInt(l.raw), decimals: l.decimals, what: "undecodable" as const }));
}

const ui = (raw: bigint, decimals: number) => Number(raw < 0n ? -raw : raw) / 10 ** decimals;

/**
 * An independent walk of each token's inventory over the ledger (not the PnL engine): which sales find no inventory, how
 * much is missing, and whether an acquisition of the same token sits in the very same slot (order not determinable).
 */
export function findOrphans(ledger: Ledger, engine: PnlResult, windowStart: number | null, dustRatio: number): Orphans {
  const all = ledger.entries.flatMap(movesOf);
  const inv = new Map<string, bigint>();
  const sales = new Map<string, OrphanSale[]>();
  const categories = new Map<string, Set<OrphanCategory>>();

  all.forEach((m, i) => {
    const before = inv.get(m.mint) ?? 0n;
    if (m.raw > 0n) {
      inv.set(m.mint, before + m.raw);
      return;
    }
    const need = -m.raw;
    inv.set(m.mint, before >= need ? before - need : 0n);
    if (m.what !== "sell" || before >= need) return;
    const e = m.entry as Extract<LedgerEntry, { kind: "trade" }>;
    const slot = e.slot;
    const after = all.slice(i + 1).filter((x) => x.mint === m.mint && x.raw > 0n);
    const sameSlotAfter = slot === null ? [] : after.filter((x) => x.entry.slot === slot).map((x) => x.entry.signature);
    const orphan = need - (before > 0n ? before : 0n);
    const sale: OrphanSale = {
      ...ref(e),
      mint: m.mint,
      tokenAmount: ui(need, m.decimals),
      inventoryBefore: ui(before, m.decimals),
      orphanAmount: ui(orphan, m.decimals),
      hoursAfterWindowStart: windowStart === null ? null : (e.time - windowStart) / 3_600_000,
      sameSlotAcquisitionsAfter: sameSlotAfter,
      laterAcquisitions: after.length,
    };
    (sales.get(m.mint) ?? sales.set(m.mint, []).get(m.mint)!).push(sale);
    const cat: OrphanCategory = sameSlotAfter.length > 0 ? "order_ambiguity" : orphan <= BigInt(Math.floor(Number(need) * dustRatio)) ? "rounding" : before > 0n ? "partial_inventory" : "pre_window";
    (categories.get(m.mint) ?? categories.set(m.mint, new Set()).get(m.mint)!).add(cat);
  });

  const order: OrphanCategory[] = ["order_ambiguity", "partial_inventory", "pre_window", "rounding"];
  const groups: OrphanGroup[] = [...sales].map(([mint, list]) => ({
    mint,
    category: order.find((c) => categories.get(mint)!.has(c))!,
    sales: list,
    totalOrphanAmount: list.reduce((a, s) => a + s.orphanAmount, 0),
    reboughtLater: list.some((s) => s.laterAcquisitions > 0),
  }));
  groups.sort((a, b) => (a.sales[0].time ?? 0) - (b.sales[0].time ?? 0));

  // Same-slot cases: a token with both an acquisition and a disposal in one slot.
  const bySlot = new Map<string, Move[]>();
  for (const m of all) if (m.entry.slot !== null) (bySlot.get(`${m.mint}|${m.entry.slot}`) ?? bySlot.set(`${m.mint}|${m.entry.slot}`, []).get(`${m.mint}|${m.entry.slot}`)!).push(m);
  const orphanSigs = new Set([...sales.values()].flat().map((s) => s.signature));
  const sameSlot: SameSlotCase[] = [];
  for (const [key, ms] of bySlot) {
    if (!(ms.some((m) => m.raw > 0n) && ms.some((m) => m.raw < 0n))) continue;
    const firstDisposal = ms.findIndex((m) => m.raw < 0n);
    const acquisitionAfterDisposal = ms.some((m, i) => m.raw > 0n && i > firstDisposal);
    const [mint, slot] = key.split("|");
    sameSlot.push({
      mint,
      slot: Number(slot),
      sequence: ms.map((m) => ({ signature: m.entry.signature, what: m.what })),
      effect: ms.some((m) => orphanSigs.has(m.entry.signature)) && acquisitionAfterDisposal ? "creates_orphan_sale" : acquisitionAfterDisposal ? "order_matters" : "none",
    });
  }
  sameSlot.sort((a, b) => a.slot - b.slot);

  const engineTokens = new Set(engine.rounds.filter((r) => r.unknownReasons.includes("sell_without_known_buy")).map((r) => r.mint));
  const walkerTokens = new Set(sales.keys());
  const agree = engineTokens.size === walkerTokens.size && [...walkerTokens].every((t) => engineTokens.has(t));
  const salesCount = [...sales.values()].reduce((a, l) => a + l.length, 0);
  return {
    status: ledger.entries.length === 0 ? "impossible" : "ok",
    reason: ledger.entries.length === 0 ? "aucune opération sur token dans le cache" : undefined,
    salesWithoutKnownBuy: salesCount,
    distinctTokens: groups.length,
    groups,
    sameSlot,
    engineCrossCheck: { engineTokens: engineTokens.size, walkerTokens: walkerTokens.size, agree },
  };
}
