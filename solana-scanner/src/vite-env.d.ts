/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Overrides the API base URL (default "/dex", proxied by Vite). */
  readonly VITE_DEXSCREENER_BASE_URL?: string;
}
