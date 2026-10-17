/**
 * Fictional transactions reproducing the STRUCTURES observed in the diagnostic of the real wallet (no real data):
 * a 0.00165 SOL micro buy at slot 457746451 that engine v1 filed as a transfer, pool SOL deltas that fell inside the old
 * numeric "rent" range, Token-2022-sized accounts, temporary co-signer keys, unprovable sponsors, airdrops, routes.
 */

import type { HistoryTx } from "../../src/history/types.ts";
import { addr, ATA_PROGRAM, DEMO_START, DEX_PROGRAM, swapTx, tx, USDC_MINT, WSOL_MINT } from "../../src/smart-money/demo/fixtures.ts";
import { deriveAta } from "../../src/smart-money/solana/pda.ts";

export const W = addr(11);
export const T0 = DEMO_START;
export const H = 3_600_000;
export const SUSPECT_SLOT = 457_746_451;
export const MINT = {
  micro: addr(120), microSell: addr(121), poolInBand: addr(122), t22: addr(123), temp: addr(124), sponsor: addr(125),
  airdropFree: addr(126), airdropPaid: addr(127), route: addr(128), amm: addr(129), oldHolding: addr(130), roundTrip: addr(131),
};

export function heatLikeTxs(): HistoryTx[] {
  const sw = (sig: string, h: number, mint: string, o: Partial<Parameters<typeof swapTx>[0]> = {}) => swapTx({ sig, time: T0 + h * H, wallet: W, mint, side: "buy", ui: 100, tradeSol: 0.5, ...o });
  const out: HistoryTx[] = [];
  // Sold, bought nothing in the window: the buy is older than the collected history.
  out.push(sw("old-sell-1", 1, MINT.oldHolding, { side: "sell", tradeSol: 0.4 }), sw("old-sell-2", 2, MINT.oldHolding, { side: "sell", tradeSol: 0.3 }));
  // A clean round trip.
  out.push(sw("rt-b", 10, MINT.roundTrip, { tradeSol: 1 }), sw("rt-s", 20, MINT.roundTrip, { side: "sell", tradeSol: 1.5 }));
  // THE suspect: ~0.001655 SOL leaves the wallet (0.00163 to the curve + 0.00002 protocol fee + 5000 lamports network fee).
  out.push(sw("suspect-micro", 30, MINT.micro, { slot: SUSPECT_SLOT, tradeSol: 0.00163, protocolFeeSol: 0.00002, programs: [DEX_PROGRAM, ATA_PROGRAM] }));
  // A micro sell.
  out.push(sw("micro-sell", 31, MINT.microSell, { side: "sell", tradeSol: 0.002, protocolFeeSol: 0.00002 }));
  // A pool whose SOL delta (2,200,000) falls in the old 890,880–3,000,000 "rent" range.
  out.push(sw("pool-in-band", 32, MINT.poolInBand, { tradeSol: 0.0022, programs: [DEX_PROGRAM, ATA_PROGRAM] }));
  // Token-2022-sized account, created by the wallet.
  out.push(sw("t22-create", 40, MINT.t22, { tradeSol: 1, createAta: true, token2022: true, rentLamports: 2_157_600 }));
  // Temporary co-signer key that nets nothing: the wallet paid.
  out.push(sw("temp-cosigner", 41, MINT.temp, { createAta: true, signers: [W, addr(250)] }));
  // Another signer pays the rent: unprovable.
  out.push(sw("sponsored", 42, MINT.sponsor, { createAta: true, signers: [W, addr(252)], rentPayer: addr(252) }));
  // Airdrop: the sender creates the wallet's account and pays (third-party deposit); the wallet does not sign.
  const sender = addr(77);
  out.push({
    signature: "airdrop-free", slot: Math.floor((T0 + 50 * H) / 400), time: T0 + 50 * H, failed: false, feePayer: sender, signers: [sender], signersComplete: true, fee: 5000,
    lamportDeltas: { [sender]: -(2_039_280 + 5000), [deriveAta(W, MINT.airdropFree)]: 2_039_280 },
    tokenDeltas: { [W]: { [MINT.airdropFree]: { raw: "1000000", decimals: 6 } }, [sender]: { [MINT.airdropFree]: { raw: "-1000000", decimals: 6 } } },
    programIds: [ATA_PROGRAM, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], origin: "helius-gtfa", providerHint: null,
  });
  // Airdrop where the WALLET signs and pays the account rent to receive free tokens: not a swap, no payment by the sender.
  out.push({
    signature: "airdrop-paid", slot: Math.floor((T0 + 51 * H) / 400), time: T0 + 51 * H, failed: false, feePayer: W, signers: [W], signersComplete: true, fee: 5000,
    lamportDeltas: { [W]: -(2_039_280 + 5000), [deriveAta(W, MINT.airdropPaid)]: 2_039_280 },
    tokenDeltas: { [W]: { [MINT.airdropPaid]: { raw: "5000000", decimals: 6 } }, [sender]: { [MINT.airdropPaid]: { raw: "-5000000", decimals: 6 } } },
    // A distributor program is involved (so this is not rejected as a plain token transfer): the evidence decides.
    programIds: [addr(190), ATA_PROGRAM, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], origin: "helius-gtfa", providerHint: null,
  });
  // Route: the wallet paid SOL, the last pool received USDC (another asset).
  const route = sw("route", 60, MINT.route, { tradeSol: 0.3 });
  route.lamportDeltas = { [W]: -(0.3 * 1e9 + 5000), [addr(196)]: 0.3 * 1e9 };
  route.tokenDeltas[POOL_ROUTE] = { [MINT.route]: { raw: "-100000000", decimals: 6 }, [USDC_MINT]: { raw: "40000000", decimals: 6 } };
  out.push(route);
  // Constant-product AMM: the pool vault receives wrapped SOL (a token), not lamports.
  out.push(tx({ sig: "amm", time: T0 + 61 * H, wallet: W, sol: -(0.25 + 0.000005), tokens: { [MINT.amm]: { ui: 40 } } }));
  const amm = out[out.length - 1];
  amm.tokenDeltas[POOL_AMM] = { [MINT.amm]: { raw: "-40000000", decimals: 6 }, [WSOL_MINT]: { raw: "250000000", decimals: 9 } };
  return out;
}
const POOL_ROUTE = addr(195);
const POOL_AMM = addr(194);
