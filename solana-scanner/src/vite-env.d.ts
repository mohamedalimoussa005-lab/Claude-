/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Overrides the API base URL (default "/dex", proxied by Vite). */
  readonly VITE_DEXSCREENER_BASE_URL?: string;
  /** Solana RPC endpoint for the on-chain analysis (default: "/solana-rpc", proxied by Vite to public mainnet-beta). */
  readonly VITE_SOLANA_RPC_URL?: string;
}
