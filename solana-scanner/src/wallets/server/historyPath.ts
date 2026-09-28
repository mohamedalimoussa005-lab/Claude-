/**
 * SERVER-SIDE ONLY. Which history path Wallet Intelligence uses in backend
 * processes (scripts, Node server). NEW (WalletHistoryService, step 4.2) is the
 * default; OLD (step 4 RPC path) stays available explicitly for comparison and
 * debugging. The browser UI does not use this module and is unchanged.
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

export type HistoryPath = "new" | "old";

export const DEFAULT_HISTORY_PATH: HistoryPath = "new";

/** CLI flags: `--old-history` selects OLD; `--history` (former opt-in for NEW) is accepted and changes nothing; `--deep` allows selective DEEP on NEW. */
export function parseHistoryPathArgs(args: string[]): { path: HistoryPath; deep: boolean } {
  const path: HistoryPath = args.includes("--old-history") ? "old" : DEFAULT_HISTORY_PATH;
  return { path, deep: path === "new" && args.includes("--deep") };
}

export function createServerWalletIntelService(o: {
  rpc: WalletRpc & Parameters<typeof createServerProviders>[0]["rpc"];
  dex: PriceClient;
  env: Record<string, string | undefined>;
  path?: HistoryPath;
  deep?: boolean;
  config?: WalletConfig;
  cache?: HistoryCache;
  onHistoryRequest?: (e: HistoryLogEntry) => void;
}): { service: WalletIntelService; path: HistoryPath; heliusEnabled: boolean | null } {
  const path = o.path ?? DEFAULT_HISTORY_PATH;
  const config = o.config ?? WALLET_CONFIG;
  if (path === "old") return { service: new WalletIntelService(o.rpc, o.dex, config), path, heliusEnabled: null };
  const history = createServerProviders({ env: o.env, rpc: o.rpc, onRequest: o.onHistoryRequest });
  // Helius providers are shared; the public-RPC history provider uses each run's guarded RPC (circuit breaker).
  const heliusOnly = history.providers.filter((p) => p.name !== "public_rpc");
  const service = new WalletIntelService(o.rpc, o.dex, config, {
    history: ({ rpc }) => new WalletHistoryService({ providers: [...heliusOnly, new PublicRpcHistoryProvider(rpc)], ...(o.cache ? { cache: o.cache } : {}) }),
    deep: !!o.deep,
  });
  return { service, path, heliusEnabled: history.heliusEnabled };
}
