import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The browser talks to "/dex", which Vite forwards to the public DEX Screener
// API. This sidesteps any CORS restriction in dev and preview.
const dexProxy = {
  "/dex": {
    target: "https://api.dexscreener.com",
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/dex/, ""),
  },
};

export default defineConfig({
  plugins: [react()],
  server: { proxy: dexProxy },
  preview: { proxy: dexProxy },
});
