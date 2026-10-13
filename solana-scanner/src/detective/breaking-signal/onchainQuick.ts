/** Quick, read-only on-chain facts about an announced address (few calls, no analysis). */

import type { ParsedMintAccount } from "../../onchain/rpc.ts";
import { candidatesFromPairs } from "../social-radar/TopicToTokenMatcher.ts";
import type { RadarDex } from "../social-radar/TopicToTokenMatcher.ts";
import type { Homonym, OnchainQuick } from "./types.ts";

const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);

export interface QuickDeps {
  rpc: { getParsedAccount(address: string): Promise<ParsedMintAccount | null> };
  dex: Pick<RadarDex, "getTokenPools" | "searchPairs">;
}

const authority = (v: unknown): string | null | "UNKNOWN" => (v === null ? null : typeof v === "string" ? v : "UNKNOWN");

export async function checkMintQuick(d: QuickDeps, mint: string): Promise<OnchainQuick> {
  const out: OnchainQuick = { mint, state: "unknown", program: null, supply: null, decimals: null, mintAuthority: "UNKNOWN", freezeAuthority: "UNKNOWN", pools: [], reason: null };
  try {
    const [acct, pools] = await Promise.all([d.rpc.getParsedAccount(mint), d.dex.getTokenPools("solana", mint).catch(() => null)]);
    if (acct === null) {
      out.state = "not_found";
      out.reason = "compte introuvable sur la chaîne";
    } else if (!TOKEN_PROGRAMS.has(acct.owner)) {
      out.state = "not_a_mint";
      out.program = acct.owner;
      out.reason = "le compte n'appartient pas à un programme de jetons";
    } else {
      const parsed = Array.isArray(acct.data) ? undefined : acct.data.parsed;
      if (parsed?.type !== "mint") {
        out.state = "not_a_mint";
        out.program = acct.owner;
        out.reason = "compte de jetons mais pas un mint";
      } else {
        const i = parsed.info ?? {};
        out.state = "valid_mint";
        out.program = acct.owner;
        out.supply = typeof i.supply === "string" ? i.supply : null;
        out.decimals = typeof i.decimals === "number" ? i.decimals : null;
        out.mintAuthority = authority(i.mintAuthority);
        out.freezeAuthority = authority(i.freezeAuthority);
      }
    }
    const raw = pools;
    if (raw) {
      const arr = Array.isArray(raw) ? raw : ((raw as { pairs?: unknown[] }).pairs ?? []);
      out.pools = (arr as Record<string, unknown>[])
        .filter((p) => p.chainId === "solana")
        .map((p) => ({ dexId: typeof p.dexId === "string" ? p.dexId : null, pairAddress: String(p.pairAddress ?? ""), liquidityUsd: typeof (p.liquidity as { usd?: unknown })?.usd === "number" ? ((p.liquidity as { usd: number }).usd) : null, url: typeof p.url === "string" ? p.url : null, createdAt: typeof p.pairCreatedAt === "number" ? p.pairCreatedAt : null }))
        .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
        .slice(0, 3);
    }
  } catch (e) {
    out.reason = e instanceof Error ? e.message : String(e);
  }
  return out;
}

/** Tokens whose name or symbol contains a cited name: context only, never evidence of an official link. */
export async function findHomonyms(d: Pick<RadarDex, "searchPairs">, names: string[], exclude: string | null): Promise<Homonym[]> {
  const seen = new Map<string, Homonym>();
  for (const n of names) {
    let raw: unknown;
    try {
      raw = await d.searchPairs(n);
    } catch {
      continue;
    }
    for (const c of candidatesFromPairs(raw)) {
      if (c.mint === exclude) continue;
      const hay = `${c.name ?? ""} ${c.symbol ?? ""}`.toLowerCase();
      if (!hay.includes(n.toLowerCase())) continue;
      seen.set(c.mint, { mint: c.mint, name: c.name, symbol: c.symbol, liquidityUsd: c.liquidityUsd, url: c.url });
    }
  }
  return [...seen.values()].sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0)).slice(0, 10);
}
