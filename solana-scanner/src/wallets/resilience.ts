/**
 * Wallet-local failure handling (step 4.2b). A provider / RPC failure makes
 * the affected facts UNKNOWN for that wallet only; the token analysis goes on.
 * Failures are recorded as codes in the facts and the token diagnostics —
 * they never become a flag, a penalty or any other scoring input.
 */

import type { FailureKind } from "../history/failure.ts";
import type { WalletFacts, WalletFailure, WalletStage } from "./types.ts";

export function addFailure(f: WalletFacts, stage: WalletStage, kind: FailureKind, skipped = false): void {
  const cur: WalletFailure = f.failure ?? { kind, stages: [], skipped: false };
  cur.stages.push({ stage, kind });
  cur.kind = cur.stages[0].kind;
  cur.skipped = cur.skipped || skipped;
  f.failure = cur;
}

/** Facts of a wallet whose history could not be read at all: everything UNKNOWN. */
export function unknownWalletFacts(address: string, stage: WalletStage, kind: FailureKind, skipped: boolean): WalletFacts {
  const f: WalletFacts = {
    address,
    signatureCount: 0,
    historyComplete: false,
    firstSeen: null,
    funder: null,
    fundingSignature: null,
    fundingTime: null,
    funderSignatureCount: null,
    signatures: [],
    trades: null,
    historyNote: skipped ? `UNKNOWN : historique non demandé (fournisseur indisponible pour cette analyse : ${kind})` : `UNKNOWN : historique non récupéré (${kind})`,
    undecodableTxs: 0,
  };
  addFailure(f, stage, kind, skipped);
  return f;
}
