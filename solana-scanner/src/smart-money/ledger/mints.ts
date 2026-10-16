/** Stablecoins treated as USD quote legs, at their nominal value of 1 USD (no market price is read). */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const STABLE_MINTS: ReadonlySet<string> = new Set([USDC_MINT, USDT_MINT]);
