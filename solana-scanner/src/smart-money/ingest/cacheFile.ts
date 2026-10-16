import { MemoryHistoryCache } from "../../history/cache.ts";
import type { HistoryCacheSnapshot } from "../../history/cache.ts";

/** A cache from a saved snapshot; a corrupt or foreign file gives an empty cache, never a half-loaded one. */
export function cacheFromSnapshot(raw: unknown): MemoryHistoryCache {
  const s = raw as HistoryCacheSnapshot | null;
  if (!s || !Array.isArray(s.txs) || !Array.isArray(s.states) || typeof s.wallets !== "object") return new MemoryHistoryCache();
  return MemoryHistoryCache.fromSnapshot(s);
}
