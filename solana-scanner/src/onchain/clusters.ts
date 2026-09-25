/**
 * "Potentially related wallets": simple heuristics between large holders.
 * These are hints, never proof of common ownership.
 *
 * Links:
 *   strong — funded in the same transaction; one funded by the other;
 *            appear together in the same transaction(s); funded by the same
 *            address within a few minutes of each other
 *   medium — funded by the same (not busy) address, at different times
 *   weak   — same busy funder (likely an exchange / service) at different
 *            times; or only first activity close in time
 * Groups are built from strong and medium links only.
 */

import type { WalletHistory } from "./types.ts";

export type LinkStrength = "strong" | "medium" | "weak";
export type LinkType = "sameTx" | "fundedBy" | "sharedTx" | "sameFunderClose" | "sameFunder" | "sameBusyFunder" | "timing";

export interface WalletLink {
  a: string;
  b: string;
  type: LinkType;
  /** Funder address or funding signature the link is about, when relevant. */
  key: string | null;
  strength: LinkStrength;
  reason: string;
}

export interface WalletGroup {
  members: { address: string; pct: number }[];
  /** Combined % held (same basis as the input pct). */
  share: number;
  /** Summarised reasons (one line per shared funder / pattern). */
  reasons: string[];
}

export interface RelatedWallets {
  analyzed: number;
  /** Wallets whose first transaction (and funder) could be established. */
  withKnownFunding: number;
  links: WalletLink[];
  groups: WalletGroup[];
  strongLinks: number;
}

export interface ClusterOptions {
  closeCreationMinutes: number;
  busyFunderSignatures: number;
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const STRENGTH: Record<LinkType, LinkStrength> = {
  sameTx: "strong",
  fundedBy: "strong",
  sharedTx: "strong",
  sameFunderClose: "strong",
  sameFunder: "medium",
  sameBusyFunder: "weak",
  timing: "weak",
};

export function findRelatedWallets(wallets: WalletHistory[], options: ClusterOptions | number): RelatedWallets {
  const opts: ClusterOptions = typeof options === "number" ? { closeCreationMinutes: options, busyFunderSignatures: 1000 } : options;
  const closeMs = opts.closeCreationMinutes * 60_000;
  const links: WalletLink[] = [];

  for (let i = 0; i < wallets.length; i++) {
    for (let j = i + 1; j < wallets.length; j++) {
      const a = wallets[i];
      const b = wallets[j];
      const add = (type: LinkType, key: string | null, reason: string) =>
        links.push({ a: a.address, b: b.address, type, key, strength: STRENGTH[type], reason });
      const close = a.firstSeen !== null && b.firstSeen !== null && Math.abs(a.firstSeen - b.firstSeen) <= closeMs;
      const gapMin = a.firstSeen !== null && b.firstSeen !== null ? Math.abs(a.firstSeen - b.firstSeen) / 60_000 : null;

      if (a.fundingSignature && a.fundingSignature === b.fundingSignature) {
        add("sameTx", a.fundingSignature, `${short(a.address)} et ${short(b.address)} financés dans la même transaction`);
      } else if (a.funder && a.funder === b.funder) {
        const busy = (a.funderSignatureCount ?? 0) >= opts.busyFunderSignatures;
        if (close) add("sameFunderClose", a.funder, `${short(a.address)} et ${short(b.address)} financés par ${short(a.funder)} à ${gapMin!.toFixed(1)} min d'écart`);
        else if (busy) add("sameBusyFunder", a.funder, `${short(a.address)} et ${short(b.address)} financés par ${short(a.funder)}, adresse très active (probablement un exchange ou un service)`);
        else add("sameFunder", a.funder, `${short(a.address)} et ${short(b.address)} financés par la même adresse ${short(a.funder)} (peut être un exchange)`);
      } else if (close) {
        add("timing", null, `${short(a.address)} et ${short(b.address)} actifs pour la première fois à ${gapMin!.toFixed(1)} min d'écart`);
      }
      if (a.funder === b.address) add("fundedBy", b.address, `${short(a.address)} financé par ${short(b.address)}`);
      if (b.funder === a.address) add("fundedBy", a.address, `${short(b.address)} financé par ${short(a.address)}`);

      const bSigs = new Set(b.signatures);
      const shared = a.signatures.filter((s) => bSigs.has(s) && s !== a.fundingSignature);
      if (shared.length) add("sharedTx", null, `${short(a.address)} et ${short(b.address)} apparaissent ensemble dans ${shared.length} transaction(s)`);
    }
  }

  // Union-find over strong + medium links.
  const parent = new Map(wallets.map((w) => [w.address, w.address]));
  const find = (x: string): string => {
    const p = parent.get(x)!;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  for (const l of links) if (l.strength !== "weak") parent.set(find(l.a), find(l.b));

  const byRoot = new Map<string, WalletHistory[]>();
  for (const w of wallets) {
    const r = find(w.address);
    byRoot.set(r, [...(byRoot.get(r) ?? []), w]);
  }
  const groups: WalletGroup[] = [];
  for (const members of byRoot.values()) {
    if (members.length < 2) continue;
    const set = new Set(members.map((m) => m.address));
    groups.push({
      members: members.map((m) => ({ address: m.address, pct: m.pct })),
      share: members.reduce((s, m) => s + m.pct, 0),
      reasons: summarize(links.filter((l) => set.has(l.a) && set.has(l.b)), opts),
    });
  }
  groups.sort((x, y) => y.share - x.share);

  return {
    analyzed: wallets.length,
    withKnownFunding: wallets.filter((w) => w.funder !== null).length,
    links,
    groups,
    strongLinks: links.filter((l) => l.strength === "strong").length,
  };
}

/** One readable line per pattern instead of one line per pair. */
function summarize(links: WalletLink[], opts: ClusterOptions): string[] {
  const buckets = new Map<string, WalletLink[]>();
  for (const l of links) {
    const k = `${l.type}|${l.key ?? ""}`;
    buckets.set(k, [...(buckets.get(k) ?? []), l]);
  }
  const order: LinkType[] = ["sameTx", "fundedBy", "sameFunderClose", "sharedTx", "sameFunder", "sameBusyFunder", "timing"];
  const out: string[] = [];
  for (const type of order) {
    for (const [k, ls] of buckets) {
      if (!k.startsWith(`${type}|`)) continue;
      const key = ls[0].key;
      const wallets = new Set(ls.flatMap((l) => [l.a, l.b])).size;
      switch (type) {
        case "sameTx":
          out.push(`${wallets} wallets financés dans la même transaction`);
          break;
        case "fundedBy":
          out.push(...ls.map((l) => l.reason));
          break;
        case "sameFunderClose":
          out.push(`${wallets} wallets financés par ${short(key!)} à moins de ${opts.closeCreationMinutes} min d'écart`);
          break;
        case "sharedTx":
          out.push(`${ls.length} paire(s) de wallets apparaissent ensemble dans les mêmes transactions`);
          break;
        case "sameFunder":
          out.push(`${wallets} wallets financés par la même adresse ${short(key!)} à des moments différents (peut être un exchange)`);
          break;
        case "sameBusyFunder":
          out.push(`${wallets} wallets financés par ${short(key!)}, adresse très active (probablement un exchange ou un service)`);
          break;
        case "timing":
          out.push(`${ls.length} paire(s) actives pour la première fois à moins de ${opts.closeCreationMinutes} min d'écart`);
          break;
      }
    }
  }
  return out;
}
