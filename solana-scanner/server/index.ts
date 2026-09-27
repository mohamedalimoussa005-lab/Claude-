/**
 * Wallet history API server (Node only, no framework). Local-only: listens on
 * 127.0.0.1. Vite forwards /api to it in dev and preview.
 *
 *   npm run server        (reads solana-scanner/.env if present)
 *
 * Environment (server-side only, never VITE_*):
 *   HELIUS_API_KEY              optional; enables Helius history and the authenticated
 *                               Solana RPC (public RPC stays the fallback)
 *   SOLANA_RPC_URL              optional custom public endpoint (must not carry a key)
 *   WALLET_HISTORY_DEEP_TOKEN   optional; without it DEEP is disabled
 *   WALLET_HISTORY_PORT         default 8787
 *   WALLET_HISTORY_CACHE        snapshot file, default .cache/wallet-history.json
 *
 * Nothing secret is ever printed: startup logs say only whether Helius and
 * DEEP are enabled.
 */

import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { createServerSolanaRpc } from "../src/rpc/serverRpc.ts";
import { createServerProviders } from "../src/history/server/heliusEnv.ts";
import { createWalletHistoryApp, ROUTE } from "./app.ts";
import { SERVER_CONFIG } from "./config.ts";
import { FileSnapshotStore } from "./snapshotStore.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

const env = process.env;
const port = Number(env.WALLET_HISTORY_PORT ?? SERVER_CONFIG.port);
const deepToken = env.WALLET_HISTORY_DEEP_TOKEN?.trim() || null;
const serverRpc = createServerSolanaRpc({ env });
const { providers, heliusEnabled } = createServerProviders({ env, rpc: serverRpc.rpc });
const store = new FileSnapshotStore(env.WALLET_HISTORY_CACHE ?? ".cache/wallet-history.json");

const app = createWalletHistoryApp({
  providers,
  store,
  deepToken,
  log: (e) => console.log(`[wallet-history] ${e.status} ${e.mode ?? "-"} ${e.ms}ms${e.error ? ` ${e.error}` : ""}${e.detail ? ` (${e.detail})` : ""}`),
});

const server = createServer(app.handler);
server.listen(port, SERVER_CONFIG.host, () => {
  console.log(`[wallet-history] http://${SERVER_CONFIG.host}:${port}${ROUTE} — Helius: ${heliusEnabled ? "enabled" : "disabled (public RPC only)"} — RPC: ${serverRpc.providers.join(" → ")} — DEEP: ${deepToken ? "token required" : "disabled"}`);
});

const stop = async () => {
  server.close();
  await app.flush();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
