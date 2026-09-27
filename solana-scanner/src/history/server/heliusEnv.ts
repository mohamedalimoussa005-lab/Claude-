/**
 * SERVER-SIDE ONLY. Builds the wallet history service for a backend process
 * (Node server / serverless function), reading the Helius key from the
 * process environment. Never import this from src/ui: the key must never
 * reach the browser (no VITE_* variable, no localStorage, no API response).
 *
 * Without a key, the service runs on the public RPC only.
 */

import type { SolanaRpc } from "../../onchain/rpc.ts";
import type { HistoryCache } from "../cache.ts";
import { HISTORY_CONFIG } from "../config.ts";
import type { HistoryConfig } from "../config.ts";
import { HeliusHistoryProvider } from "../helius.ts";
import { assertServerSide } from "../provider.ts";
import { PublicRpcHistoryProvider } from "../publicRpc.ts";
import { WalletHistoryService } from "../service.ts";
import type { HistoryLogEntry, WalletHistoryProvider } from "../types.ts";

/** The Helius key from a server environment, or null. Only HELIUS_API_KEY is read (never a VITE_* variable). */
export function readHeliusKey(env: Record<string, string | undefined>): string | null {
  assertServerSide("readHeliusKey");
  const key = env.HELIUS_API_KEY?.trim();
  return key ? key : null;
}

export function createServerHistoryService(o: {
  env: Record<string, string | undefined>;
  rpc: Pick<SolanaRpc, "getSignatures" | "getTransaction">;
  cache?: HistoryCache;
  config?: HistoryConfig;
  onRequest?: (e: HistoryLogEntry) => void;
}): { service: WalletHistoryService; heliusEnabled: boolean } {
  const config = o.config ?? HISTORY_CONFIG;
  const providers: WalletHistoryProvider[] = [];
  const key = readHeliusKey(o.env);
  if (key) providers.push(new HeliusHistoryProvider({ apiKey: key, config: config.helius, onRequest: o.onRequest }));
  providers.push(new PublicRpcHistoryProvider(o.rpc, config.publicRpc));
  return { service: new WalletHistoryService({ providers, cache: o.cache, config }), heliusEnabled: key !== null };
}
