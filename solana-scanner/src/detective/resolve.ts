/** Token → pools, from DEX Screener (public). Parsing is defensive: a field that is missing stays null. */

import { isSolanaAddress } from "../social/validate.ts";

export interface DexPort {
  getTokenPools(chainId: string, tokenAddress: string): Promise<unknown>;
}

export interface PoolInfo {
  pairAddress: string;
  dexId: string | null;
  labels: string[];
  url: string | null;
  baseMint: string;
  baseSymbol: string | null;
  baseName: string | null;
  quoteMint: string | null;
  quoteSymbol: string | null;
  priceUsd: number | null;
  priceNative: number | null;
  /** USD per whole quote token = priceUsd / priceNative (DEX Screener's own pair of numbers). */
  usdPerQuote: number | null;
  liquidityUsd: number | null;
  volumeH24: number | null;
  buysH24: number | null;
  sellsH24: number | null;
  fdv: number | null;
  marketCap: number | null;
  pairCreatedAt: number | null;
}

export interface SocialLink {
  type: string;
  url: string;
  label?: string;
}

export interface DexProfile {
  websites: SocialLink[];
  socials: SocialLink[];
  imageUrl: string | null;
}

export interface Resolution {
  mint: string;
  pools: PoolInfo[];
  primary: PoolInfo | null;
  /** Profile (links) from the primary pool, or from any pool that carries one. */
  profile: DexProfile;
  notes: string[];
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function parsePools(raw: unknown, mint: string): { pools: PoolInfo[]; profiles: DexProfile[]; notes: string[] } {
  const notes: string[] = [];
  const arr: unknown[] = Array.isArray(raw) ? raw : Array.isArray(obj(raw).pairs) ? (obj(raw).pairs as unknown[]) : [];
  const pools: PoolInfo[] = [];
  const profiles: DexProfile[] = [];
  for (const item of arr) {
    const p = obj(item);
    const base = obj(p.baseToken);
    const quote = obj(p.quoteToken);
    const pair = str(p.pairAddress);
    if (!pair || !isSolanaAddress(pair)) continue;
    if (str(p.chainId) !== "solana") continue;
    if (str(base.address) !== mint) {
      if (str(quote.address) === mint) notes.push(`pool ${pair}: le token est du côté cotation (ignoré)`);
      continue;
    }
    const priceUsd = num(p.priceUsd);
    const priceNative = num(p.priceNative);
    const liq = obj(p.liquidity);
    const vol = obj(p.volume);
    const tx = obj(obj(p.txns).h24);
    pools.push({
      pairAddress: pair,
      dexId: str(p.dexId),
      labels: Array.isArray(p.labels) ? p.labels.filter((l): l is string => typeof l === "string") : [],
      url: str(p.url),
      baseMint: mint,
      baseSymbol: str(base.symbol),
      baseName: str(base.name),
      quoteMint: str(quote.address),
      quoteSymbol: str(quote.symbol),
      priceUsd,
      priceNative,
      usdPerQuote: priceUsd !== null && priceNative !== null && priceNative > 0 ? priceUsd / priceNative : null,
      liquidityUsd: num(liq.usd),
      volumeH24: num(vol.h24),
      buysH24: num(tx.buys),
      sellsH24: num(tx.sells),
      fdv: num(p.fdv),
      marketCap: num(p.marketCap),
      pairCreatedAt: num(p.pairCreatedAt),
    });
    const info = obj(p.info);
    const links = (v: unknown, kind: "websites" | "socials"): SocialLink[] =>
      (Array.isArray(v) ? v : []).flatMap((x) => {
        const o = obj(x);
        const url = str(o.url);
        return url ? [{ type: str(o.type) ?? (kind === "websites" ? "website" : "unknown"), url, ...(str(o.label) ? { label: str(o.label)! } : {}) }] : [];
      });
    profiles.push({ websites: links(info.websites, "websites"), socials: links(info.socials, "socials"), imageUrl: str(info.imageUrl) });
  }
  return { pools, profiles, notes };
}

export async function resolveToken(dex: DexPort, mint: string): Promise<Resolution> {
  if (!isSolanaAddress(mint)) throw new Error(`adresse de token invalide: ${mint}`);
  const raw = await dex.getTokenPools("solana", mint);
  const { pools, profiles, notes } = parsePools(raw, mint);
  const order = pools.map((p, i) => ({ p, i })).sort((a, b) => (b.p.liquidityUsd ?? -1) - (a.p.liquidityUsd ?? -1) || a.i - b.i);
  const primary = order[0]?.p ?? null;
  const idx = primary ? pools.indexOf(primary) : -1;
  const profile = (idx >= 0 && (profiles[idx]!.websites.length || profiles[idx]!.socials.length) ? profiles[idx] : profiles.find((x) => x.websites.length || x.socials.length)) ?? { websites: [], socials: [], imageUrl: idx >= 0 ? profiles[idx]!.imageUrl : null };
  if (pools.length === 0) notes.push("DEX Screener ne liste aucun pool Solana pour ce token (token trop récent, sans pool, ou adresse erronée)");
  if (pools.length > 1) notes.push(`${pools.length} pools listés; le plus liquide est analysé (les autres ne sont pas inclus dans les simulations)`);
  return { mint, pools: order.map((o) => o.p), primary, profile, notes };
}

// ───────────────────────────── venue classification ─────────────────────────────

export type VenueClass =
  | { supported: true; kind: "clmm" | "cpmm" | "pumpswap"; program: string; programName: string }
  | { supported: false; program: string | null; programName: string | null; reason: string };

const PROGRAMS: Record<string, { name: string; kind?: "clmm" | "cpmm" | "pumpswap"; why?: string }> = {
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: { name: "Raydium CLMM", kind: "clmm" },
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: { name: "Raydium CP-Swap", kind: "cpmm" },
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: { name: "PumpSwap", kind: "pumpswap" },
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": { name: "pump.fun (courbe de bonding)", why: "courbe de bonding pump.fun avant migration: la formule d'exécution de la courbe n'est pas implémentée dans le moteur de profondeur" },
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": { name: "Raydium AMM v4", why: "pool Raydium AMM v4: formule non implémentée dans le moteur de profondeur" },
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: { name: "Orca Whirlpool", why: "Orca Whirlpool: non pris en charge par le moteur de profondeur" },
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: { name: "Meteora DLMM", why: "Meteora DLMM: non pris en charge par le moteur de profondeur" },
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: { name: "Meteora DAMM v2", why: "Meteora DAMM v2: non pris en charge par le moteur de profondeur" },
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: { name: "Meteora Dynamic Bonding Curve", why: "courbe de bonding Meteora avant migration: non prise en charge" },
  LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj: { name: "Raydium LaunchLab (courbe de bonding)", why: "courbe de bonding LaunchLab avant migration: non prise en charge" },
};

/** The program that owns the pool account decides the venue (more reliable than DEX Screener's dexId). */
export function classifyVenue(ownerProgram: string | null, dexId: string | null): VenueClass {
  if (!ownerProgram) return { supported: false, program: null, programName: null, reason: `compte du pool introuvable ou illisible (dexId ${dexId ?? "inconnu"})` };
  const p = PROGRAMS[ownerProgram];
  if (p?.kind) return { supported: true, kind: p.kind, program: ownerProgram, programName: p.name };
  if (p) return { supported: false, program: ownerProgram, programName: p.name, reason: p.why ?? "venue non prise en charge" };
  return { supported: false, program: ownerProgram, programName: null, reason: `programme du pool inconnu (${ownerProgram}, dexId ${dexId ?? "inconnu"}): venue non prise en charge` };
}
