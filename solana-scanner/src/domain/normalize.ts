/**
 * Turns raw DEX Screener JSON into one flat, typed shape.
 *
 * Every metric is `number | null`: null means "absent or unusable in the API
 * response", never zero. Numeric strings (the API sends priceUsd as a string)
 * are parsed; anything non-finite becomes null.
 */

export interface NormalizedPair {
  chainId: string;
  dexId: string | null;
  url: string | null;
  pairAddress: string;

  tokenAddress: string;
  tokenName: string | null;
  tokenSymbol: string | null;
  quoteSymbol: string | null;

  priceUsd: number | null;
  marketCap: number | null;
  fdv: number | null;
  liquidityUsd: number | null;

  volumeM5: number | null;
  volumeH1: number | null;
  volumeH6: number | null;
  volumeH24: number | null;

  buysM5: number | null;
  sellsM5: number | null;
  buysH1: number | null;
  sellsH1: number | null;

  priceChangeM5: number | null;
  priceChangeH1: number | null;
  priceChangeH6: number | null;

  /** Unix epoch in milliseconds. */
  pairCreatedAt: number | null;
}

/** Metric fields, in the order the user asked for them. */
export const METRIC_FIELDS = [
  "tokenName",
  "tokenSymbol",
  "priceUsd",
  "marketCap",
  "fdv",
  "liquidityUsd",
  "volumeM5",
  "volumeH1",
  "volumeH6",
  "volumeH24",
  "buysM5",
  "sellsM5",
  "buysH1",
  "sellsH1",
  "priceChangeM5",
  "priceChangeH1",
  "priceChangeH6",
  "pairCreatedAt",
  "dexId",
  "url",
] as const satisfies readonly (keyof NormalizedPair)[];

/** The DEX Screener JSON path each normalised field comes from. */
export const SOURCE_PATH: Record<keyof NormalizedPair, string> = {
  chainId: "chainId",
  dexId: "dexId",
  url: "url",
  pairAddress: "pairAddress",
  tokenAddress: "baseToken.address",
  tokenName: "baseToken.name",
  tokenSymbol: "baseToken.symbol",
  quoteSymbol: "quoteToken.symbol",
  priceUsd: "priceUsd",
  marketCap: "marketCap",
  fdv: "fdv",
  liquidityUsd: "liquidity.usd",
  volumeM5: "volume.m5",
  volumeH1: "volume.h1",
  volumeH6: "volume.h6",
  volumeH24: "volume.h24",
  buysM5: "txns.m5.buys",
  sellsM5: "txns.m5.sells",
  buysH1: "txns.h1.buys",
  sellsH1: "txns.h1.sells",
  priceChangeM5: "priceChange.m5",
  priceChangeH1: "priceChange.h1",
  priceChangeH6: "priceChange.h6",
  pairCreatedAt: "pairCreatedAt",
};

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function get(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const key of path.split(".")) {
    if (!isObj(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function toText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s === "" ? null : s;
}

function toCount(v: unknown): number | null {
  const n = toNumber(v);
  return n !== null && n >= 0 && Number.isInteger(n) ? n : null;
}

function toTimestampMs(v: unknown): number | null {
  const n = toNumber(v);
  if (n === null || n <= 0) return null;
  // pairCreatedAt is documented in ms; tolerate seconds just in case.
  return n < 1e12 ? n * 1000 : n;
}

/**
 * Normalises one raw pair. Returns null when the pair cannot be identified
 * (no pair address or no base token address).
 */
export function normalizePair(raw: unknown): NormalizedPair | null {
  if (!isObj(raw)) return null;
  const pairAddress = toText(raw.pairAddress);
  const tokenAddress = toText(get(raw, "baseToken.address"));
  if (!pairAddress || !tokenAddress) return null;

  const num = (field: keyof NormalizedPair) => toNumber(get(raw, SOURCE_PATH[field]));
  const count = (field: keyof NormalizedPair) => toCount(get(raw, SOURCE_PATH[field]));
  const text = (field: keyof NormalizedPair) => toText(get(raw, SOURCE_PATH[field]));

  return {
    chainId: text("chainId") ?? "unknown",
    dexId: text("dexId"),
    url: text("url"),
    pairAddress,
    tokenAddress,
    tokenName: text("tokenName"),
    tokenSymbol: text("tokenSymbol"),
    quoteSymbol: text("quoteSymbol"),
    priceUsd: num("priceUsd"),
    marketCap: num("marketCap"),
    fdv: num("fdv"),
    liquidityUsd: num("liquidityUsd"),
    volumeM5: num("volumeM5"),
    volumeH1: num("volumeH1"),
    volumeH6: num("volumeH6"),
    volumeH24: num("volumeH24"),
    buysM5: count("buysM5"),
    sellsM5: count("sellsM5"),
    buysH1: count("buysH1"),
    sellsH1: count("sellsH1"),
    priceChangeM5: num("priceChangeM5"),
    priceChangeH1: num("priceChangeH1"),
    priceChangeH6: num("priceChangeH6"),
    pairCreatedAt: toTimestampMs(get(raw, SOURCE_PATH.pairCreatedAt)),
  };
}

/** Extracts the pair list from either a bare array or a `{ pairs: [...] }` envelope. */
export function extractPairs(response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  if (isObj(response) && Array.isArray(response.pairs)) return response.pairs;
  return [];
}

export interface DiscoveredToken {
  chainId: string;
  tokenAddress: string;
}

/** Reads {chainId, tokenAddress} entries from profile / boost responses. */
export function extractTokenRefs(response: unknown): DiscoveredToken[] {
  if (!Array.isArray(response)) return [];
  const out: DiscoveredToken[] = [];
  for (const item of response) {
    if (!isObj(item)) continue;
    const chainId = toText(item.chainId);
    const tokenAddress = toText(item.tokenAddress);
    if (chainId && tokenAddress) out.push({ chainId, tokenAddress });
  }
  return out;
}

export type FieldCoverage = Record<(typeof METRIC_FIELDS)[number], number>;

/** Per field, how many pairs carry a value. */
export function fieldCoverage(pairs: NormalizedPair[]): FieldCoverage {
  const cov = Object.fromEntries(METRIC_FIELDS.map((f) => [f, 0])) as FieldCoverage;
  for (const p of pairs) for (const f of METRIC_FIELDS) if (p[f] !== null) cov[f]++;
  return cov;
}
