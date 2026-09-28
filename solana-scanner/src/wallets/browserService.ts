/**
 * Wallet Intelligence for the browser UI: the NEW history layer (step 4.2),
 * with wallet histories served by the local backend (/api/wallet-history)
 * through HttpHistorySource. Same modules and rules as the backend scripts
 * (buyers + structural bridge, QUICK, QUICK completion, bot signals,
 * relationships, clusters, Quality / Confidence). DEEP is never allowed here,
 * and there is no other history path or fallback: when the backend is
 * unavailable, wallet histories are UNKNOWN.
 */

import { HttpHistorySource } from "../history/httpSource.ts";
import type { HttpHistorySourceOptions } from "../history/httpSource.ts";
import type { WalletRpc } from "./collect.ts";
import { WALLET_CONFIG } from "./config.ts";
import type { WalletConfig } from "./config.ts";
import { WalletIntelService } from "./service.ts";
import type { PriceClient } from "./service.ts";

export function createBrowserWalletIntelService(rpc: WalletRpc, dex: PriceClient, o: { history?: HttpHistorySourceOptions; config?: WalletConfig } = {}): WalletIntelService {
  return new WalletIntelService(rpc, dex, o.config ?? WALLET_CONFIG, {
    // One client per token run: a backend that went down in one run is retried on the next.
    history: () => new HttpHistorySource(o.history),
    deep: false,
  });
}
