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

export default defineConfig({
  plugins: [react()],
  server: { proxy: dexProxy },
  preview: { proxy: dexProxy },
});
