/** Public surface of SMART MONEY TRACKER (phases 0-2). Other agents import from here or read the outbox. */
export * from "./config.ts";
export * from "./contract/types.ts";
export * from "./contract/events.ts";
export { SmartMoneyStore } from "./store/store.ts";
export * from "./ledger/types.ts";
export { buildLedger } from "./ledger/build.ts";
export * from "./pnl/types.ts";
export { computePnl } from "./pnl/fifo.ts";
export { analyzeWallet, profileFromPnl, coverageFromCompleteness } from "./pnl/profile.ts";
export type { WalletPnlProfile } from "./pnl/profile.ts";
export { wilson } from "./pnl/stats.ts";
