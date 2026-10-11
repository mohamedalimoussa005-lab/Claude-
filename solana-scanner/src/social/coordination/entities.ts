/**
 * Entities that must not be read as "a wallet that coordinates": programs, routers, tip accounts, and any service
 * the caller knows (exchanges, bridges, public bots). The built-in list only holds program ids and Jito tip
 * accounts. Exchange hot wallets and bot wallets are NOT hard-coded: they change, and a wrong label would turn a
 * fact into an error. Callers pass their own labelled addresses; unlabelled high-activity funders are flagged
 * "service_probable" by a stated heuristic (see funding.ts).
 */

import type { KnownEntity } from "./model.ts";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
/** Decimals of the quote tokens the analysis can express in human units; any other quote mint stays in raw units. */
export const QUOTE_DECIMALS: Readonly<Record<string, number>> = { [WSOL_MINT]: 9, [USDC_MINT]: 6, [USDT_MINT]: 6 };
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";

export const DEX_PROGRAMS: Readonly<Record<string, string>> = {
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump bonding curve",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "PumpSwap",
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: "Raydium CP-Swap",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "Raydium CLMM",
  routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS: "Raydium Route",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM v4",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpool",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora DLMM",
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: "Meteora DAMM v2",
  LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj: "Raydium LaunchLab",
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: "Meteora DAMM v1",
  "24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi": "Meteora vault",
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: "Meteora Dynamic Bonding Curve",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter v6",
};

/** Aggregators: they move tokens on behalf of a user, they are not a trader. */
export const ROUTER_PROGRAMS: Readonly<Record<string, string>> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter v6",
  routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS: "Raydium Route",
};

/** Jito tip accounts (priority tips paid by traders; not funding, not a counterparty). */
export const JITO_TIP_ACCOUNTS: readonly string[] = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

export function builtinEntities(): Map<string, KnownEntity> {
  const m = new Map<string, KnownEntity>();
  for (const [a, label] of Object.entries(DEX_PROGRAMS)) m.set(a, { kind: ROUTER_PROGRAMS[a] ? "router" : "program", label });
  for (const a of JITO_TIP_ACCOUNTS) m.set(a, { kind: "service_probable", label: "Jito tip account" });
  m.set(SYSTEM_PROGRAM, { kind: "program", label: "System program" });
  return m;
}

/** Merge caller-supplied labels over the built-in ones. */
export function entityMap(extra: Readonly<Record<string, KnownEntity>> = {}): Map<string, KnownEntity> {
  const m = builtinEntities();
  for (const [a, e] of Object.entries(extra)) m.set(a, e);
  return m;
}

/** An entity whose shared use proves nothing about the wallets that use it. */
export function isNeutralEntity(e: KnownEntity | undefined): boolean {
  return e !== undefined && e.kind !== "creator";
}
