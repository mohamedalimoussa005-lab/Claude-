import { createEvent } from "../contract/events.ts";
import type { NewEvent } from "../contract/types.ts";
import type { DataQualityLevel } from "../contract/types.ts";
import type { WalletPnlProfile } from "./profile.ts";
import type { PnlResult } from "./types.ts";

/** `wallet.profile_computed`: the PnL profile as an event for CHIEF / DETECTIVE. Evidence = signatures of the KNOWN rounds. */
export function profileEvent(profile: WalletPnlProfile, pnl: PnlResult, o: { now: number; criteriaVersion: string; simulated: boolean }): NewEvent<WalletPnlProfile> {
  const known = pnl.rounds.filter((r) => r.status === "KNOWN");
  const last = pnl.rounds.at(-1)?.signatures.at(-1) ?? "none";
  const level: DataQualityLevel = !profile.coverage.complete ? "LOW" : profile.winRate.sample === "sufficient" && profile.counts.partial === 0 && (profile.knownShare ?? 0) >= 0.8 ? "HIGH" : "MEDIUM";
  const unknowns = [
    ...(profile.coverage.complete ? [] : ["history_incomplete"]),
    ...(profile.winRate.sample === "insufficient" ? ["sample_insufficient"] : []),
    ...Object.keys(profile.unknownReasons).map((r) => `unknown:${r}`),
    ...(profile.counts.partial ? ["partial_rent_unattributed"] : []),
    ...(profile.open.length ? ["open_positions_unvalued"] : []),
  ];
  return createEvent({
    kind: "wallet.profile_computed",
    wallet: profile.wallet,
    dedupKey: `profile@${o.criteriaVersion}@${last}@${pnl.rounds.length}`,
    evidence: known.slice(-50).flatMap((r) => r.signatures.slice(0, 1).map((signature) => ({ signature, slot: null, time: r.closedAt }))),
    evidenceTier: "VERIFIED",
    quality: { level, unknowns },
    criteriaVersion: o.criteriaVersion,
    simulated: o.simulated,
    data: profile,
    now: o.now,
  });
}
