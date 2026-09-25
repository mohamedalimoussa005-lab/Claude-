/**
 * Classifies a token holder. A holder is "technical" (excluded from adjusted
 * concentration) only when this is verifiable:
 *   - its owner is the DEX Screener pair address (the pool itself), or
 *   - its owner account is owned by a known AMM / bonding-curve program, or
 *   - it is a documented pool authority or burn address.
 * Anything else stays in the concentration figures, including accounts owned
 * by unknown programs (lockers, vesting, multisig… can't be verified).
 */

import { KNOWN_ADDRESSES, KNOWN_PROGRAMS, SYSTEM_PROGRAM } from "./config.ts";
import type { OwnerInfo } from "./types.ts";

export type HolderKind = "pool" | "bondingCurve" | "burn" | "programOwned" | "wallet" | "noAccount" | "unclassified";

export interface HolderClass {
  kind: HolderKind;
  label: string;
  /** Verified technical account → excluded from adjusted concentration. */
  excluded: boolean;
  evidence: string;
}

export function classifyHolder(owner: string, info: OwnerInfo | undefined, pairAddress: string | null): HolderClass {
  if (pairAddress && owner === pairAddress) {
    const prog = info?.program ? KNOWN_PROGRAMS[info.program] : undefined;
    return {
      kind: "pool",
      label: prog ? prog.name : "Pool de liquidité (paire DEX Screener)",
      excluded: true,
      evidence: "le propriétaire du compte est l'adresse de la paire DEX Screener",
    };
  }
  const known = KNOWN_ADDRESSES[owner];
  if (known) {
    return { kind: known.kind, label: known.name, excluded: true, evidence: "adresse documentée et vérifiée on-chain" };
  }
  if (!info) return { kind: "unclassified", label: "Non classé", excluded: false, evidence: "compte propriétaire non récupéré" };
  if (!info.exists) {
    return { kind: "noAccount", label: "Wallet sans compte SOL", excluded: false, evidence: "aucun compte on-chain à cette adresse (0 SOL)" };
  }
  const prog = info.program ? KNOWN_PROGRAMS[info.program] : undefined;
  if (prog) {
    return { kind: prog.kind, label: prog.name, excluded: true, evidence: `compte détenu par le programme ${prog.name} (${info.program})` };
  }
  if (info.program === SYSTEM_PROGRAM) return { kind: "wallet", label: "Wallet", excluded: false, evidence: "compte système (wallet)" };
  return {
    kind: "programOwned",
    label: "Compte de programme non identifié",
    excluded: false,
    evidence: `détenu par le programme ${info.program} : usage non vérifiable, conservé dans les calculs`,
  };
}

export function isTechnical(c: HolderClass): boolean {
  return c.excluded;
}
