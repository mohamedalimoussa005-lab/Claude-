/**
 * Verification of a post's origin and of the contract address it announces. Levels and their explicit criteria:
 *
 *   CONFIRMÉ     C1 author id is on the watch list AND C2 original post AND C3 a valid Solana address is in the post text
 *                (or on a page of that account's official domains linked from the post) AND C4 that address is a mint on-chain.
 *   PROBABLE     C1 and C2 hold, but the contract is NOT established: no address, an address only on a non-official page,
 *                or the on-chain check failed/unavailable. (An authentic mention of a project, not an announced contract.)
 *   NON VÉRIFIÉ  anything else: author not on the list, handle/id mismatch, reply/quote/repost, or simulation of a stranger.
 *
 * A token that merely uses the name (search results) NEVER raises a level: only the announced address counts.
 */

import { hostOf } from "./extract.ts";
import type { Criterion, Extraction, OnchainQuick, PostEvent, Verification, WatchedAccount } from "./types.ts";
import { findAddresses } from "../social-radar/text.ts";

/** Handle with look-alike characters folded (I/l/1, O/0, rn/m): two handles with the same skeleton are suspicious twins. */
export const skeleton = (h: string): string => h.toLowerCase().replace(/rn/g, "m").replace(/[il1|]/g, "l").replace(/[o0]/g, "o").replace(/[_\s]/g, "");

export type PageFetcher = (url: string) => Promise<string | null>;

export interface VerifyInput {
  event: PostEvent;
  extraction: Extraction;
  accounts: WatchedAccount[];
  /** Reads a page of an official domain (injected; null = unavailable). */
  fetchPage?: PageFetcher;
  /** Quick on-chain check of an address (injected; null = unavailable within the fast budget). */
  checkMint?: (mint: string) => Promise<OnchainQuick | null>;
}

export async function verifyPost(i: VerifyInput): Promise<{ verification: Verification; onchain: OnchainQuick | null }> {
  const { event: e, extraction: x } = i;
  const notes: string[] = [];
  const criteria: Criterion[] = [];
  const acct = i.accounts.find((a) => a.userId === e.authorId) ?? null;
  const c1 = acct !== null;
  criteria.push({ id: "C1", ok: c1, text: c1 ? `auteur ${e.authorId} présent dans la liste blanche (${acct!.label})` : `auteur ${e.authorId} (@${e.handle}) ABSENT de la liste blanche: un pseudo ressemblant n'est pas une identité` });
  if (acct && acct.handle && acct.handle.toLowerCase() !== e.handle.toLowerCase()) notes.push(`le pseudo a changé (liste blanche @${acct.handle}, publication @${e.handle}): à contrôler, l'identifiant numérique fait foi`);
  const twin = !acct ? i.accounts.find((a) => skeleton(a.handle) === skeleton(e.handle)) : undefined;
  if (twin) notes.push(`USURPATION POSSIBLE: le pseudo @${e.handle} est ${twin.handle.toLowerCase() === e.handle.toLowerCase() ? "identique" : "quasi identique"} à celui du compte surveillé @${twin.handle} mais l'identifiant ${e.authorId} est différent`);
  const c2 = e.kind === "original";
  criteria.push({ id: "C2", ok: c2, text: c2 ? "publication originale du compte" : `publication de type « ${e.kind} »: ce n'est pas une annonce propre du compte` });

  // C3: address in the post, else on an official-domain page linked from the post
  let officialAddress: string | null = null;
  let addressSource: Verification["addressSource"] = null;
  if (x.addresses.length === 1) {
    officialAddress = x.addresses[0]!;
    addressSource = "post";
  } else if (x.addresses.length > 1) {
    notes.push(`${x.addresses.length} adresses dans le post: aucune n'est retenue comme « annoncée » (ambiguïté)`);
  } else if (acct && i.fetchPage) {
    const linked = x.urls.filter((u) => {
      const h = hostOf(u);
      return h !== null && acct.officialDomains.some((d) => h === d || h.endsWith(`.${d}`));
    });
    for (const u of linked.slice(0, 2)) {
      const html = await i.fetchPage(u);
      if (html === null) {
        notes.push(`page officielle ${u} illisible: adresse non établie`);
        continue;
      }
      const found = findAddresses(html);
      if (found.length === 1) {
        officialAddress = found[0]!;
        addressSource = "official-page";
        break;
      }
      if (found.length > 1) notes.push(`page officielle ${u}: ${found.length} adresses possibles, aucune retenue`);
    }
    if (linked.length === 0 && x.urls.length) notes.push("liens du post hors des domaines officiels déclarés: ils ne servent pas à établir une adresse");
  }
  const c3 = officialAddress !== null;
  criteria.push({ id: "C3", ok: c3, text: c3 ? `adresse ${officialAddress} ${addressSource === "post" ? "citée dans le post" : "lue sur une page officielle liée"}` : "aucune adresse de contrat établie par le post ou par une page officielle" });

  // C4: on-chain
  let onchain: OnchainQuick | null = null;
  if (officialAddress && i.checkMint) onchain = await i.checkMint(officialAddress);
  const c4 = officialAddress === null ? null : onchain === null ? null : onchain.state === "valid_mint" ? true : onchain.state === "unknown" ? null : false;
  criteria.push({ id: "C4", ok: c4, text: officialAddress === null ? "sans objet (pas d'adresse)" : c4 === true ? "l'adresse est bien un mint SPL on-chain" : c4 === false ? `l'adresse n'est pas un mint valide (${onchain!.state})` : "vérification on-chain indisponible dans le délai" });

  let level: Verification["level"] = "NON VÉRIFIÉ";
  if (c1 && c2) level = c3 && c4 === true ? "CONFIRMÉ" : "PROBABLE";
  if (c1 && c2 && c3 && c4 === false) notes.push("l'adresse annoncée n'est pas un mint: possible erreur ou fausse adresse, ne pas utiliser");
  if (e.provenance === "simulation") notes.push("SIMULATION: événement fictif, aucune publication réelle n'a été lue");
  return { verification: { level, criteria, officialAddress, addressSource, notes }, onchain };
}
