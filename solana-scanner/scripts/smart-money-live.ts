/**
 * Lives in scripts/ (not src/) on purpose: the project forbids any src/ module from importing rpc/serverRpc, which keeps the
 * authenticated-RPC code out of every browser bundle. The CLI receives this factory by injection (see scripts/smart-money.ts).
 *
 * The only module that can reach the network (through the history providers).
 * It builds the providers the repo already has, but hands them a fetch that
 * is wrapped by the call / credit budget and the allow-list. The Helius key
 * is read from the server environment, kept inside the providers, and never
 * printed, stored or returned.
 */

import { HISTORY_CONFIG } from "../src/history/config.ts";
import type { HistoryConfig } from "../src/history/config.ts";
import { HeliusHistoryProvider } from "../src/history/helius.ts";
import { PublicRpcHistoryProvider } from "../src/history/publicRpc.ts";
import { readHeliusKey } from "../src/history/server/heliusEnv.ts";
import { WalletHistoryService } from "../src/history/service.ts";
import type { WalletHistoryProvider } from "../src/history/types.ts";
import { ONCHAIN_CONFIG } from "../src/onchain/config.ts";
import { createServerSolanaRpc } from "../src/rpc/serverRpc.ts";
import { allowedHostsFor, budgetedFetch } from "../src/smart-money/ingest/budget.ts";
import type { LiveService, LiveServiceOptions } from "../src/smart-money/ingest/liveTypes.ts";

export function createLiveService(o: LiveServiceOptions): LiveService {
  const inner = o.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const guarded = budgetedFetch(inner, o.budget, allowedHostsFor(o.env));
  const key = readHeliusKey(o.env);
  // The probe of getTransactionsForAddress (Developer plan+) is bounded to one small page.
  const config: HistoryConfig = { ...HISTORY_CONFIG, helius: { ...HISTORY_CONFIG.helius, maxPrimaryLimit: Math.min(o.pageLimit, 100), ...(o.testRates ? { maxRequestsPerSecond: o.testRates.heliusPerSecond } : {}) } };
  const rpcWindow = o.testRates?.rpcPerWindow ?? 80;
  const perMethodWindow = o.testRates?.rpcPerWindow ?? 40;
  const providers: WalletHistoryProvider[] = [];
  let transport = () => "";

  if (o.provider === "helius-rpc") {
    if (!key) throw new Error("--provider helius-rpc needs HELIUS_API_KEY");
    // Free plan: 10 RPC requests/s. Stay well under it, and under the public RPC's 40 per method per 10 s (used only as a fallback).
    const rpcConfig = { ...ONCHAIN_CONFIG, rpc: { ...ONCHAIN_CONFIG.rpc, maxRequests: rpcWindow, windowMs: 10_000, perMethod: { ...ONCHAIN_CONFIG.rpc.perMethod, getTransaction: perMethodWindow, getSignaturesForAddress: perMethodWindow } } };
    const { rpc } = createServerSolanaRpc({ env: { HELIUS_API_KEY: key, SOLANA_RPC_URL: o.env.SOLANA_RPC_URL }, config: rpcConfig, fetchImpl: guarded });
    providers.push(new PublicRpcHistoryProvider(rpc, { ...config.publicRpc, maxPageLimit: Math.min(o.pageLimit, 100) }));
    transport = () => rpc.diagnostics().providers.map((p) => `${p.label}: ${p.ok} ok / ${p.failed} échecs${p.state === "unavailable_for_run" ? ` (désactivé : ${p.openedBy})` : ""}`).join(" · ");
  } else {
    if (o.provider !== "public" && key) providers.push(new HeliusHistoryProvider({ apiKey: key, config: config.helius, fetchImpl: guarded }));
    if (o.provider !== "helius") {
      // Keyless on purpose: every Helius request goes through HeliusHistoryProvider here.
      const publicConfig = o.testRates ? { ...ONCHAIN_CONFIG, rpc: { ...ONCHAIN_CONFIG.rpc, maxRequests: o.testRates.rpcPerWindow, perMethod: { ...ONCHAIN_CONFIG.rpc.perMethod, getTransaction: o.testRates.rpcPerWindow, getSignaturesForAddress: o.testRates.rpcPerWindow } } } : undefined;
      const { rpc } = createServerSolanaRpc({ env: { SOLANA_RPC_URL: o.env.SOLANA_RPC_URL }, config: publicConfig, fetchImpl: guarded });
      providers.push(new PublicRpcHistoryProvider(rpc, config.publicRpc));
    }
  }
  if (providers.length === 0) throw new Error("no history provider available (Helius requested without HELIUS_API_KEY)");
  return { service: new WalletHistoryService({ providers, cache: o.cache, config }), providers: providers.map((p) => p.name), transport };
}
