/**
 * SERVER-SIDE ONLY. Wallet Intelligence for backend processes (scripts, Node
 * server): WalletIntelService on the history layer with the server's history
 * providers (Helius when HELIUS_API_KEY is set → enhanced fallback → public
 * RPC). The browser uses createBrowserWalletIntelService instead, which reaches
 * the same layer through /api/wallet-history.
 */

import type { HistoryCache } from "../../history/cache.ts";
import { PublicRpcHistoryProvider } from "../../history/publicRpc.ts";
import { createServerProviders } from "../../history/server/heliusEnv.ts";
import { WalletHistoryService } from "../../history/service.ts";
import type { HistoryLogEntry } from "../../history/types.ts";
import type { WalletRpc } from "../collect.ts";
import { WALLET_CONFIG } from "../config.ts";
import type { WalletConfig } from "../config.ts";
import { WalletIntelService } from "../service.ts";
import type { PriceClient } from "../service.ts";

export function createServerWalletIntelService(o: {
  rpc: WalletRpc & Parameters<typeof createServerProviders>[0]["rpc"];
  dex: PriceClient;
  env: Record<string, string | undefined>;
  /** Selective DEEP (≤ historyLayer.deepMaxWalletsPerToken per token); off by default. */
  deep?: boolean;
  config?: WalletConfig;
  cache?: HistoryCache;
  onHistoryRequest?: (e: HistoryLogEntry) => void;
}): { service: WalletIntelService; heliusEnabled: boolean } {
  const history = createServerProviders({ env: o.env, rpc: o.rpc, onRequest: o.onHistoryRequest });
  // Helius providers are shared; the public-RPC history provider uses each run's guarded RPC (circuit breaker).
  const heliusOnly = history.providers.filter((p) => p.name !== "public_rpc");
  const service = new WalletIntelService(o.rpc, o.dex, o.config ?? WALLET_CONFIG, {
    history: ({ rpc }) => new WalletHistoryService({ providers: [...heliusOnly, new PublicRpcHistoryProvider(rpc)], ...(o.cache ? { cache: o.cache } : {}) }),
    deep: !!o.deep,
  });
  return { service, heliusEnabled: history.heliusEnabled };
}
