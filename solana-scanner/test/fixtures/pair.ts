/**
 * A pair object shaped like the documented DEX Screener "Pair" schema
 * (https://docs.dexscreener.com/api/reference). Values are illustrative.
 */
export function rawPair(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chainId: "solana",
    dexId: "raydium",
    url: "https://dexscreener.com/solana/PAIRaddr1111111111111111111111111111111111",
    pairAddress: "PAIRaddr1111111111111111111111111111111111",
    labels: ["CPMM"],
    baseToken: { address: "TOKENaddr111111111111111111111111111111pump", name: "Test Coin", symbol: "TEST" },
    quoteToken: { address: "So11111111111111111111111111111111111111112", name: "Wrapped SOL", symbol: "SOL" },
    priceNative: "0.00000009",
    priceUsd: "0.00001234",
    txns: {
      m5: { buys: 12, sells: 7 },
      h1: { buys: 140, sells: 95 },
      h6: { buys: 800, sells: 600 },
      h24: { buys: 3000, sells: 2500 },
    },
    volume: { h24: 250000.5, h6: 90000, h1: 15000.25, m5: 1200 },
    priceChange: { m5: 1.5, h1: -3.2, h6: 12, h24: 40 },
    liquidity: { usd: 45000.12, base: 1800000000, quote: 150 },
    fdv: 12340,
    marketCap: 12000,
    pairCreatedAt: 1758800000000,
    info: { imageUrl: "https://example.invalid/x.png", websites: [], socials: [] },
    boosts: { active: 10 },
    ...overrides,
  };
}
