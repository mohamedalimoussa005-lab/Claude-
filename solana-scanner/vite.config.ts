import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The browser talks to "/dex" and "/solana-rpc", which Vite forwards to the
// public DEX Screener API and the public Solana RPC. This sidesteps CORS and
// origin restrictions in dev and preview.
const dexProxy = {
  "/dex": {
    target: "https://api.dexscreener.com",
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/dex/, ""),
  },
  // Public Solana RPC (read-only on-chain analysis). The public endpoint answers
  // 403 to requests carrying a localhost Origin, so the proxy drops that header.
  "/solana-rpc": {
    target: "https://api.mainnet-beta.solana.com",
    changeOrigin: true,
    rewrite: () => "/",
    configure: (proxy: { on: (event: "proxyReq", cb: (req: { removeHeader: (name: string) => void }) => void) => void }) => {
      proxy.on("proxyReq", (req) => {
        req.removeHeader("origin");
        req.removeHeader("referer");
      });
    },
  },
};

// Wallet history API (server/index.ts, `npm run server`): the browser only ever
// calls /api; the Helius key stays in that Node process.
const apiProxy = {
  "/api": {
    target: "http://127.0.0.1:8787",
    changeOrigin: false,
  },
};

export default defineConfig({
  plugins: [react()],
  server: { proxy: { ...dexProxy, ...apiProxy } },
  preview: { proxy: { ...dexProxy, ...apiProxy } },
});
