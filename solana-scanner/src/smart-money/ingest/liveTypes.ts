/** Shapes shared by the CLI and the (scripts/) factory that can reach the network. No network code here. */

import type { HistoryCache } from "../../history/cache.ts";
import type { WalletHistoryService } from "../../history/service.ts";
import type { CallBudget } from "./budget.ts";
import type { ProviderChoice } from "./guard.ts";

export interface LiveServiceOptions {
  env: Record<string, string | undefined>;
  budget: CallBudget;
  provider: ProviderChoice;
  cache: HistoryCache;
  pageLimit: number;
  /** Tests inject a fake network here; production uses the real fetch. */
  fetchImpl?: typeof fetch;
  /** Tests only: lift the client-side rate limits so a fake network is not slowed down. Never set in production. */
  testRates?: { heliusPerSecond: number; rpcPerWindow: number };
}

export interface LiveService {
  service: WalletHistoryService;
  providers: string[];
  /** Non-sensitive description of what answered (labels and counters only). */
  transport: () => string;
}

export type LiveServiceFactory = (o: LiveServiceOptions) => LiveService;
