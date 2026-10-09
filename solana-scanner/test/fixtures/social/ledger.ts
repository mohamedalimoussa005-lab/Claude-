/**
 * Builds the Evidence Ledger of DETECTIVE Phases 2, 3, 4 and 4B from local fixtures.
 * No network. Status choices follow the reports: FACT = read directly and anchored;
 * INDICATION = derived by a stated rule; HYPOTHESIS = a possible explanation;
 * UNVERIFIED = could not be established with the tools used.
 */

import { EvidenceLedger } from "../../../src/social/ledger.ts";
import type { EvidenceFact, EvidenceInput } from "../../../src/social/types.ts";
import { CLMM_F, DEX, DEX_OBSERVED_AT, HOLDERS, MINTS_RPC, POSTS, POSTS_OBSERVED_AT, SLOTS } from "./data.ts";
import { F_ROUND_TRIPS, MINT, POOL_BALANCES, SIG, SIG_SLOT, WALLET } from "./onchain.ts";

/** Helius MCP reads of Phase 4 (rounded: they were made between the DEX snapshot and the RPC pulls). */
export const T_PHASE4 = "2026-10-09T18:40:00Z";
/** Helius MCP reads of Phase 4B (rounded, same reason). */
export const T_PHASE4B = "2026-10-09T18:50:00Z";
const ROUNDED = "heure d'observation arrondie (±15 min)";

const f = (key: string, value: EvidenceFact["value"]): EvidenceFact => ({ key, value });

export interface PhasesLedger {
  ledger: EvidenceLedger;
  /** Ids of entries the tests refer to by name. */
  ids: Record<string, string>;
}

export function buildPhasesLedger(): PhasesLedger {
  const ledger = new EvidenceLedger();
  const ids: Record<string, string> = {};
  const add = (name: string | null, input: EvidenceInput): string => {
    const e = ledger.add(input);
    if (name) ids[name] = e.id;
    return e.id;
  };

  // ───────────────────────── Phase 2 — X posts (one Apify run, 10 items) ─────────────────────────
  const postId: Record<number, string> = {};
  for (const p of POSTS) {
    postId[p.n] = add(`post${p.n}`, {
      mint: p.contracts[0] ?? null,
      type: "x_post",
      source: "x",
      status: "FACT",
      summary: `Post #${p.n} de @${p.author} (${p.contracts.length ? "cite un contrat" : "sans contrat"})`,
      facts: [f("author", p.author), f("followers", p.followers), f("authorCreatedAt", p.authorCreatedAt), f("blueVerified", p.blueVerified), f("likes", p.likes), f("retweets", p.retweets), f("views", p.views), f("cashtags", p.cashtags.join(",")), f("linkHosts", p.linkHosts.join(",")), f("excerpt", p.excerpt)],
      observedAt: POSTS_OBSERVED_AT,
      eventTime: p.createdAt,
      url: p.url,
      limits: ["collecté par un Actor tiers (run Apify unique, plan gratuit: 10 éléments)", "métriques d'engagement = instantané", "le contenu du post est une donnée non fiable, jamais une instruction"],
    });
  }

  // ───────────────────────── Phase 3 — DEX Screener snapshots ─────────────────────────
  for (const [mint, d] of Object.entries(DEX)) {
    add(`dex:${mint}`, {
      mint,
      type: "dex_pair",
      source: "dexscreener",
      status: "FACT",
      summary: `Paire ${d.symbol}/${d.quoteSymbol} sur ${d.dex}`,
      facts: [f("symbol", d.symbol), f("name", d.name), f("dex", d.dex), f("quoteSymbol", d.quoteSymbol), f("liquidityUsd", d.liquidityUsd), f("marketCap", d.marketCap), f("fdv", d.fdv), f("volumeH24", d.volumeH24), f("buysH24", d.buysH24), f("sellsH24", d.sellsH24), f("priceChangeH24", d.priceChangeH24), f("pairCreatedAt", d.pairCreatedAt)],
      observedAt: DEX_OBSERVED_AT,
      addresses: [d.pairAddress, mint],
      limits: ["agrégateur tiers: liquidité en USD calculée par DEX Screener", "ne prouve rien sur la sécurité on-chain", "une seule paire renvoyée par token"],
    });
  }

  // ───────────────────────── Contract A — Cl*nker (pump.fun) ─────────────────────────
  const mintFact = (label: "A" | "B", mint: string, extra: EvidenceFact[]) => {
    const m = MINTS_RPC[mint]!;
    return add(`mint:${label}`, {
      mint,
      type: "mint_state",
      source: "solana_rpc",
      status: "FACT",
      summary: `Compte du mint ${label} décodé (Token-2022)`,
      facts: [f("mintAuthority", m.mintAuthority), f("freezeAuthority", m.freezeAuthority), f("supplyRaw", m.supplyRaw), f("decimals", m.decimals), f("accountSize", m.accountSize), ...extra],
      observedAt: m.observedAt,
      slot: m.contextSlot,
      addresses: [mint],
      limits: ["lecture ponctuelle: les autorités non révoquées peuvent changer"],
    });
  };
  const holdersFact = (label: string, mint: string) => {
    const h = HOLDERS[mint]!;
    return add(`holders:${label}`, {
      mint,
      type: "holder_distribution",
      source: "solana_rpc",
      status: "FACT",
      summary: `Distribution complète des holders de ${label} (getProgramAccounts)`,
      facts: [f("holders", h.holders), f("tokenAccounts", h.tokenAccounts), f("poolPct", h.poolPct), f("nonPoolTop1Pct", h.nonPoolTop1Pct), f("nonPoolTop5Pct", h.nonPoolTop5Pct), f("nonPoolTop10Pct", h.nonPoolTop10Pct), f("nonPoolTop20Pct", h.nonPoolTop20Pct)],
      observedAt: h.observedAt,
      addresses: [mint, h.poolOwner],
      limits: ["instantané: la distribution évolue", "le pool est identifié par son adresse connue, les autres propriétaires ne sont pas classés", "liens entre holders non analysés"],
    });
  };

  mintFact("A", MINT.A, [f("program", "Token-2022"), f("extensions", "metadataPointer,tokenMetadata"), f("metadataUpdateAuthority", null)]);
  holdersFact("A", MINT.A);
  add("pool:A", {
    mint: MINT.A,
    type: "pool_state",
    source: "helius",
    status: "FACT",
    summary: "Réserves du pool PumpSwap de A",
    facts: [f("solReserve", POOL_BALANCES.A.sol), f("tokenReserve", POOL_BALANCES.A.tokens)],
    observedAt: T_PHASE4,
    addresses: [HOLDERS[MINT.A]!.poolOwner],
    limits: [ROUNDED, "profondeur échangeable non calculée"],
  });
  add("tx:aCreate", {
    mint: MINT.A,
    type: "transaction",
    source: "solana_rpc",
    status: "FACT",
    summary: "Création de A sur pump.fun avec achat du créateur",
    facts: [f("feePayer", WALLET.aCreator), f("devBuyTokens", 97545454.545454), f("devBuySol", 3.0375)],
    observedAt: T_PHASE4,
    eventTime: SLOTS.A_create!.blockTime,
    signature: SIG.aCreate,
    slot: SIG_SLOT.aCreate,
    addresses: [WALLET.aCreator, MINT.A],
    limits: [ROUNDED],
  });
  const sameSlotA = add("sameSlot:A", {
    mint: MINT.A,
    type: "same_slot_activity",
    source: "solana_rpc",
    status: "FACT",
    summary: "Trois wallets ont signé leur propre transaction dans le slot de création de A",
    facts: [f("slot", SIG_SLOT.aCreate), f("recipient1Signature", SIG.aRecipient1), f("recipient2Signature", SIG.aRecipient2), f("recipient3Signature", SIG.aRecipient3), f("tokensReceivedMillions", 118.2)],
    observedAt: HOLDERS[MINT.A]!.observedAt,
    eventTime: SLOTS.A_r1!.blockTime,
    signature: SIG.aRecipient1,
    slot: SIG_SLOT.aRecipient1,
    addresses: [WALLET.aRecipient1, WALLET.aRecipient2, WALLET.aRecipient3],
    limits: ["le slot est établi, pas la relation entre les trois wallets", "montants lus dans le texte parsé de Helius"],
  });
  const fundCreatorToR2 = add("fund:aCreatorToR2", {
    mint: MINT.A,
    type: "funding_link",
    source: "helius",
    status: "FACT",
    summary: "Le créateur de A a envoyé 2,3 SOL au destinataire n°2",
    facts: [f("from", WALLET.aCreator), f("to", WALLET.aRecipient2), f("sol", 2.3)],
    observedAt: T_PHASE4B,
    eventTime: "2026-04-28T17:33:10Z",
    signature: SIG.aCreatorFundsRecipient2,
    slot: SIG_SLOT.aCreatorFundsRecipient2,
    addresses: [WALLET.aCreator, WALLET.aRecipient2],
    limits: [ROUNDED],
  });
  const fundFunderToR3 = add("fund:aFunderToR3", {
    mint: MINT.A,
    type: "funding_link",
    source: "helius",
    status: "FACT",
    summary: "Un financeur commun a envoyé 2 SOL au destinataire n°3",
    facts: [f("from", WALLET.aFunder), f("to", WALLET.aRecipient3), f("sol", 2)],
    observedAt: T_PHASE4B,
    eventTime: "2025-08-09T18:21:35Z",
    signature: SIG.aFunderFundsRecipient3,
    slot: SIG_SLOT.aFunderFundsRecipient3,
    addresses: [WALLET.aFunder, WALLET.aRecipient3],
    limits: [ROUNDED],
  });
  const fundFunderToCreator = add("fund:aFunderToCreator", {
    mint: MINT.A,
    type: "funding_link",
    source: "helius",
    status: "FACT",
    summary: "Le même financeur a envoyé 1,2 SOL au créateur de A",
    facts: [f("from", WALLET.aFunder), f("to", WALLET.aCreator), f("sol", 1.2)],
    observedAt: T_PHASE4B,
    eventTime: "2026-01-06T22:10:49Z",
    signature: SIG.aFunderFundsCreator,
    slot: SIG_SLOT.aFunderFundsCreator,
    addresses: [WALLET.aFunder, WALLET.aCreator],
    limits: [ROUNDED, "seules les premières transactions de chaque wallet ont été lues"],
  });
  const lookalike = add("similar:A", {
    mint: MINT.A,
    type: "address_similarity",
    source: "helius",
    status: "FACT",
    summary: "Une adresse qui imite celle du créateur (mêmes 4 premiers et 4 derniers caractères) a envoyé 0,00001 SOL au destinataire n°2",
    facts: [f("from", WALLET.aCreatorLookalike), f("imitates", WALLET.aCreator), f("sharedPrefix", 4), f("sharedSuffix", 4), f("sol", 0.00001)],
    observedAt: T_PHASE4B,
    eventTime: "2026-04-28T17:33:44Z",
    signature: SIG.aLookalikeDust,
    slot: SIG_SLOT.aLookalikeDust,
    addresses: [WALLET.aCreatorLookalike, WALLET.aCreator, WALLET.aRecipient2],
    limits: [ROUNDED, "peut être une adresse « vanity » sans intention"],
  });
  const linkedIndication = add("ind:aLinked", {
    mint: MINT.A,
    type: "funding_link",
    source: "helius",
    status: "INDICATION",
    summary: "Deux des trois wallets du slot de création ont un lien de financement avec le créateur (direct, ou via un financeur commun)",
    facts: [f("linkedRecipients", 2), f("recipients", 3), f("tokensOfLinkedMillions", 75.5)],
    observedAt: T_PHASE4B,
    basedOn: [sameSlotA, fundCreatorToR2, fundFunderToR3, fundFunderToCreator],
    limits: ["le financement n'établit pas que les wallets appartiennent à la même personne", "le 3e wallet n'a aucun lien trouvé"],
  });
  add("hyp:aOperator", {
    mint: MINT.A,
    type: "funding_link",
    source: "helius",
    status: "HYPOTHESIS",
    summary: "Les destinataires n°2 et n°3 sont contrôlés par l'opérateur du créateur",
    facts: [f("statement", "same_operator_possible")],
    observedAt: T_PHASE4B,
    basedOn: [linkedIndication, lookalike],
    limits: ["aucune preuve de contrôle commun", "aucune conclusion d'intention"],
  });
  add("gap:A", {
    mint: MINT.A,
    type: "data_gap",
    source: "helius",
    status: "UNVERIFIED",
    summary: "Part des bundlers et nombre de tokens lancés par le créateur de A",
    facts: [],
    observedAt: T_PHASE4B,
    missing: ["nombre total de tokens créés par le créateur (le bot annonçait 328)", "classification des 122 holders", "financeur du destinataire n°1"],
    limits: ["outils: getWalletFundedBy refusé (HTTP 403, plan)"],
  });

  // ───────────────────────── Contract B — Cl*nker (rapidLaunch) ─────────────────────────
  mintFact("B", MINT.B, [f("program", "Token-2022"), f("transferFeeBps", MINTS_RPC[MINT.B]!.transferFee!.bps), f("transferFeeAuthority", WALLET.bFeeAuthority), f("withdrawAuthority", WALLET.bFeeAuthority), f("metadataUpdateAuthority", WALLET.bMetadataAuthority), f("withheldFeesRaw", MINTS_RPC[MINT.B]!.transferFee!.withheldRaw)]);
  holdersFact("B", MINT.B);
  add("pool:B", {
    mint: MINT.B,
    type: "pool_state",
    source: "helius",
    status: "UNVERIFIED",
    summary: "Réserves du pool Raydium CPMM de B",
    facts: [],
    observedAt: T_PHASE4,
    missing: ["soldes des coffres du pool: non lisibles via l'adresse de paire (propriétaire = autorité CPMM)"],
    limits: [ROUNDED],
  });
  const bFirst = add("tx:bFirst", {
    mint: MINT.B,
    type: "transaction",
    source: "solana_rpc",
    status: "FACT",
    summary: "Première transaction référençant le mint B: quatre wallets cosignent et préparent le token de cotation",
    facts: [f("feePayer", WALLET.bFirstTxPayer), f("cosigners", 4), f("quoteToken", WALLET.bQuoteToken), f("slot", SIG_SLOT.bFirstTx)],
    observedAt: T_PHASE4B,
    eventTime: SLOTS.B_first!.blockTime,
    signature: SIG.bFirstTx,
    slot: SIG_SLOT.bFirstTx,
    addresses: [WALLET.bFirstTxPayer, WALLET.bCosigner1, WALLET.bCosigner2, WALLET.bCosigner3],
    limits: ["instruction d'initialisation du mint non décodée (création par CPI du programme)", ROUNDED],
  });
  add("ind:bCosign", {
    mint: MINT.B,
    type: "same_slot_activity",
    source: "solana_rpc",
    status: "INDICATION",
    summary: "Quatre wallets agissent dans une même transaction de lancement",
    facts: [f("cosigners", 4)],
    observedAt: T_PHASE4B,
    basedOn: [bFirst],
    limits: ["cosigner une transaction ne prouve pas un contrôle commun"],
  });
  add("fee:B", {
    mint: MINT.B,
    type: "mint_state",
    source: "helius",
    status: "FACT",
    summary: "L'autorité des frais de transfert de B est un wallet ordinaire doté de 145 SOL",
    facts: [f("owner", "system_program"), f("sol", 145.144416246), f("dataBytes", 0)],
    observedAt: T_PHASE4B,
    addresses: [WALLET.bFeeAuthority],
    limits: [ROUNDED, "lien avec la plateforme rapidLaunch non vérifié"],
  });
  add("gap:B", {
    mint: MINT.B,
    type: "data_gap",
    source: "solana_rpc",
    status: "UNVERIFIED",
    summary: "Transaction de création exacte de B",
    facts: [],
    observedAt: T_PHASE4B,
    missing: ["instruction initializeMint non isolée", "créateur confirmé"],
    limits: ["la première transaction référence le mint mais ne le crée pas visiblement"],
  });
  add("cmp:AvsB", {
    mint: null,
    type: "funding_link",
    source: "helius",
    status: "INDICATION",
    summary: "Aucun financeur ni wallet commun trouvé entre les lanceurs de A et B",
    facts: [f("sharedFunder", false), f("sharedWallet", false)],
    observedAt: T_PHASE4B,
    basedOn: [fundFunderToCreator, bFirst],
    limits: ["absence de preuve ≠ preuve d'absence: seules les premières transactions ont été lues", "getWalletFundedBy indisponible (HTTP 403)"],
  });

  // ───────────────────────── Contract C — QUANTUM ─────────────────────────
  add("mint:C", {
    mint: MINT.C,
    type: "mint_state",
    source: "helius",
    status: "FACT",
    summary: "Compte du mint C (Token-2022)",
    facts: [f("mintAuthority", null), f("freezeAuthority", null), f("supplyRaw", "979048090389471"), f("decimals", 6), f("metadataUpdateAuthority", null)],
    observedAt: T_PHASE4,
    addresses: [MINT.C],
    limits: [ROUNDED],
  });
  holdersFact("C", MINT.C);
  add("pool:C", {
    mint: MINT.C,
    type: "pool_state",
    source: "helius",
    status: "FACT",
    summary: "Réserves du pool PumpSwap de C",
    facts: [f("solReserve", POOL_BALANCES.C.sol), f("tokenReserve", POOL_BALANCES.C.tokens)],
    observedAt: T_PHASE4,
    addresses: [HOLDERS[MINT.C]!.poolOwner],
    limits: [ROUNDED, "profondeur échangeable non calculée"],
  });
  const cCreate = add("tx:cCreate", {
    mint: MINT.C,
    type: "transaction",
    source: "solana_rpc",
    status: "FACT",
    summary: "Création de C sur pump.fun avec achat du créateur",
    facts: [f("feePayer", WALLET.cCreator), f("devBuyTokens", 3564784.053156), f("devBuySol", 0.1)],
    observedAt: T_PHASE4B,
    eventTime: SLOTS.C_create!.blockTime,
    signature: SIG.cCreate,
    slot: SIG_SLOT.cCreate,
    addresses: [WALLET.cCreator, MINT.C],
    limits: [ROUNDED],
  });
  const cSniper = add("tx:cSniper", {
    mint: MINT.C,
    type: "same_slot_activity",
    source: "solana_rpc",
    status: "FACT",
    summary: "Un wallet a acheté C dans le slot même de la création (94,76 M de tokens contre 2,93 SOL)",
    facts: [f("slot", SIG_SLOT.cSniperBuy), f("creationSlot", SIG_SLOT.cCreate), f("tokens", 94759913.649731), f("sol", 2.926)],
    observedAt: T_PHASE4B,
    eventTime: SLOTS.C_b1!.blockTime,
    signature: SIG.cSniperBuy,
    slot: SIG_SLOT.cSniperBuy,
    addresses: [WALLET.cSniper],
    limits: [ROUNDED, "seuls trois des cinq achats ont un slot confirmé"],
  });
  const cFund = add("fund:cFunder", {
    mint: MINT.C,
    type: "funding_link",
    source: "solana_rpc",
    status: "FACT",
    summary: "Financement: Dv6Emvt… envoie 0,15 SOL au wallet créateur de C, neuf minutes avant la création",
    facts: [f("from", WALLET.cFunder), f("to", WALLET.cCreator), f("sol", 0.15), f("slotsBeforeCreation", SIG_SLOT.cCreate - SIG_SLOT.cFunding)],
    observedAt: T_PHASE4B,
    eventTime: SLOTS.C_fund!.blockTime,
    signature: SIG.cFunding,
    slot: SIG_SLOT.cFunding,
    addresses: [WALLET.cFunder, WALLET.cCreator],
    limits: [ROUNDED],
  });
  const cSell = add("tx:cSell", {
    mint: MINT.C,
    type: "transaction",
    source: "solana_rpc",
    status: "FACT",
    summary: "Le créateur effectue un échange du même montant que son achat initial, 130 secondes après la création",
    facts: [f("tokens", 3564784.0532), f("slotsAfterCreation", SIG_SLOT.cCreatorSell - SIG_SLOT.cCreate)],
    observedAt: T_PHASE4B,
    eventTime: SLOTS.C_sell!.blockTime,
    signature: SIG.cCreatorSell,
    slot: SIG_SLOT.cCreatorSell,
    addresses: [WALLET.cCreator],
    limits: [ROUNDED, "le sens (vente) est déduit du montant, non lu dans l'instruction"],
  });
  const cReturn = add("fund:cReturn", {
    mint: MINT.C,
    type: "funding_link",
    source: "solana_rpc",
    status: "FACT",
    summary: "Retour de fonds: le créateur renvoie 0,156231955 SOL à Dv6Emvt…",
    facts: [f("from", WALLET.cCreator), f("to", WALLET.cFunder), f("sol", 0.156231955), f("aboveFundingSol", 0.006231955)],
    observedAt: T_PHASE4B,
    eventTime: SLOTS.C_ret!.blockTime,
    signature: SIG.cReturn,
    slot: SIG_SLOT.cReturn,
    addresses: [WALLET.cCreator, WALLET.cFunder],
    limits: [ROUNDED, "l'écart de 0,0062 SOL n'est pas expliqué"],
  });
  const cLoop = add("ind:cLoop", {
    mint: MINT.C,
    type: "funding_link",
    source: "solana_rpc",
    status: "INDICATION",
    summary: "Cycle fermé: financement du créateur, création, puis retour de fonds au financeur",
    facts: [f("funding", 0.15), f("returned", 0.156231955)],
    observedAt: T_PHASE4B,
    basedOn: [cFund, cReturn, cCreate, cSell],
    limits: ["un cycle de fonds n'établit pas que les deux wallets ont le même propriétaire"],
  });
  add("ind:cSniping", {
    mint: MINT.C,
    type: "same_slot_activity",
    source: "solana_rpc",
    status: "INDICATION",
    summary: "Schéma de sniping: un achat dans le slot de création, puis deux autres à +12 et +16 slots",
    facts: [f("slotOffsets", "0,12,16")],
    observedAt: T_PHASE4B,
    basedOn: [cSniper, cCreate],
    limits: ["les achats à +1 s de 33,8 M et 33,4 M n'ont pas de slot confirmé"],
  });
  add("hyp:cOperator", {
    mint: MINT.C,
    type: "funding_link",
    source: "solana_rpc",
    status: "HYPOTHESIS",
    summary: "Dv6Emvt… et le wallet créateur dépendent du même opérateur",
    facts: [f("statement", "same_operator_possible")],
    observedAt: T_PHASE4B,
    basedOn: [cLoop],
    limits: ["aucune preuve de contrôle commun", "aucune conclusion d'intention"],
  });
  add("fund:cSniper", {
    mint: MINT.C,
    type: "funding_link",
    source: "helius",
    status: "FACT",
    summary: "Le sniper a été financé en 4 secondes par quatre wallets (32,716 + 22,65 + 22,626 + 2,008 = 80 SOL)",
    facts: [f("totalSol", 80), f("senders", 4), f("firstSender", WALLET.cSniperFunders[0]!)],
    observedAt: T_PHASE4B,
    eventTime: "2026-09-07T09:26:05Z",
    signature: SIG.cSniperFunding1,
    slot: SIG_SLOT.cSniperFunding1,
    addresses: [WALLET.cSniper, ...WALLET.cSniperFunders],
    limits: [ROUNDED, "seule la première des quatre signatures est enregistrée"],
  });
  add("claim:cMultiple", {
    mint: MINT.C,
    type: "claim_check",
    source: "dexscreener",
    status: "UNVERIFIED",
    summary: "Posts #3 et #9: « 27X / 24X depuis mon appel »",
    facts: [],
    observedAt: DEX_OBSERVED_AT,
    basedOn: [postId[3]!, postId[9]!],
    missing: ["historique de prix (OHLC) depuis l'appel", "date et prix de l'appel cité"],
    limits: ["DEX Screener ne donne que des variations 5 min à 24 h"],
  });
  add("claim:cMascot", {
    mint: MINT.C,
    type: "claim_check",
    source: "x",
    status: "UNVERIFIED",
    summary: "Lien entre la « mascotte Quantum » du post #1 et le token QUANTUM",
    facts: [],
    observedAt: POSTS_OBSERVED_AT,
    basedOn: [postId[1]!],
    missing: ["aucun contrat cité dans le post #1", "aucune relation entre les deux publications établie"],
    limits: ["rapprochement par le seul mot « Quantum »"],
  });

  // ───────────────────────── Contracts D, E, G — tweet + DEX Screener only ─────────────────────────
  add("claim:D", {
    mint: MINT.D,
    type: "claim_check",
    source: "dexscreener",
    status: "INDICATION",
    summary: "Post #4: « de 318k à 15 M de market cap »; market cap actuel 293 k$ sur une paire de 46 jours",
    facts: [f("claimedPeakMarketCap", 15_000_000), f("currentMarketCap", DEX[MINT.D]!.marketCap), f("pairAgeDays", 46)],
    observedAt: DEX_OBSERVED_AT,
    basedOn: [postId[4]!, ids[`dex:${MINT.D}`]!],
    limits: ["le sommet éventuel est non vérifié (pas d'historique de prix)"],
  });
  add("claim:E", {
    mint: MINT.E,
    type: "claim_check",
    source: "dexscreener",
    status: "INDICATION",
    summary: "Post #5: le lien « airdrop » pointe vers un domaine différent du site officiel déclaré sur DEX Screener",
    facts: [f("postHost", "memes-airdrop.netlify.app"), f("declaredWebsite", DEX[MINT.E]!.websites[0] ?? null), f("hostsDiffer", true)],
    observedAt: DEX_OBSERVED_AT,
    basedOn: [postId[5]!, ids[`dex:${MINT.E}`]!],
    limits: ["le lien n'a pas été ouvert", "le site déclaré sur DEX Screener est lui-même une donnée déclarative"],
  });
  add("claim:G", {
    mint: MINT.G,
    type: "identity_claim",
    source: "dexscreener",
    status: "UNVERIFIED",
    summary: "Le nom du token ALON est celui d'une personne: usurpation éventuelle non établie",
    facts: [],
    observedAt: DEX_OBSERVED_AT,
    basedOn: [ids[`dex:${MINT.G}`]!],
    missing: ["lien avec la personne nommée", "comptes sociaux déclarés non vérifiés"],
    limits: ["constat sur le nom seul"],
  });

  // ───────────────────────── Contract F — « Gensyn » / AI ─────────────────────────
  add("mint:F", {
    mint: MINT.F,
    type: "mint_state",
    source: "helius",
    status: "FACT",
    summary: "Compte du mint F (SPL Token classique, sans extension)",
    facts: [f("mintAuthority", null), f("freezeAuthority", null), f("supplyRaw", "999998295232355"), f("decimals", 6), f("program", "spl-token")],
    observedAt: T_PHASE4,
    addresses: [MINT.F],
    limits: [ROUNDED, "autorités révoquées ≠ identité officielle du token"],
  });
  holdersFact("F", MINT.F);
  add("pool:F", {
    mint: MINT.F,
    type: "pool_state",
    source: "helius",
    status: "FACT",
    summary: "Soldes du pool CLMM de F: 22,72 USDC et 993,94 M de tokens",
    facts: [f("usdc", POOL_BALANCES.F.usdc), f("tokens", POOL_BALANCES.F.tokens)],
    observedAt: T_PHASE4,
    addresses: [HOLDERS[MINT.F]!.poolOwner],
    limits: [ROUNDED, "liquidité concentrée: les soldes ne donnent PAS la profondeur échangeable (voir la position)"],
  });
  add("pos:F", {
    mint: MINT.F,
    type: "liquidity_position",
    source: "solana_rpc",
    status: "FACT",
    summary: "Position CLMM unique de F: ticks −33784 à −29732, tick courant = borne basse",
    facts: [f("tickLower", CLMM_F.tickLower), f("tickUpper", CLMM_F.tickUpper), f("tickCurrent", CLMM_F.tickCurrent), f("tickSpacing", CLMM_F.tickSpacing), f("liquidity", CLMM_F.liquidity), f("positionLiquidity", CLMM_F.positionLiquidity)],
    observedAt: CLMM_F.observedAt,
    addresses: [CLMM_F.poolAddress, CLMM_F.positionAddress, CLMM_F.positionNft],
    limits: ["profondeur en USDC non calculée dans cette phase (Phase 5B)"],
  });
  add("lp:F", {
    mint: MINT.F,
    type: "liquidity_position",
    source: "helius",
    status: "FACT",
    summary: "Le NFT de la position appartient à Hhc9gBeH…, pas au minteur",
    facts: [f("nft", CLMM_F.positionNft), f("owner", WALLET.fLpOwner), f("amount", 1)],
    observedAt: T_PHASE4B,
    addresses: [CLMM_F.positionNft, WALLET.fLpOwner],
    limits: [ROUNDED],
  });
  add("tx:fMint", {
    mint: MINT.F,
    type: "transaction",
    source: "solana_rpc",
    status: "FACT",
    summary: "Mint de 999 999 999 tokens par E3UoKyex…",
    facts: [f("minter", WALLET.fMinter), f("amount", 999999999)],
    observedAt: T_PHASE4,
    eventTime: "2026-07-01T12:20:05Z",
    signature: SIG.fMint,
    slot: SIG_SLOT.fMint,
    addresses: [WALLET.fMinter, MINT.F],
    limits: [ROUNDED],
  });
  add("tx:fPool", {
    mint: MINT.F,
    type: "transaction",
    source: "solana_rpc",
    status: "FACT",
    summary: "Dépôt de 993 939 393 tokens dans un pool Raydium CLMM par le minteur",
    facts: [f("depositor", WALLET.fMinter), f("tokens", 993939393)],
    observedAt: T_PHASE4,
    eventTime: "2026-07-01T13:59:30Z",
    signature: SIG.fPoolCreate,
    slot: SIG_SLOT.fPoolCreate,
    addresses: [WALLET.fMinter, CLMM_F.poolAddress],
    limits: [ROUNDED],
  });
  const large = F_ROUND_TRIPS.large.flat();
  const usdcLegs = [...large, ...F_ROUND_TRIPS.medium.flat(), ...F_ROUND_TRIPS.tiny.flat()].reduce((s, x) => s + x, 0);
  const roundTrips = add("rt:F", {
    mint: MINT.F,
    type: "round_trip_volume",
    source: "helius",
    status: "FACT",
    summary: "Trois wallets achètent puis revendent des montants fixes à 14–33 s d'intervalle, à heure régulière",
    facts: [f("largeCycles", F_ROUND_TRIPS.large.length), f("mediumCycles", F_ROUND_TRIPS.medium.length), f("tinyCycles", F_ROUND_TRIPS.tiny.length), f("usdcLegsTotal", Math.round(usdcLegs * 100) / 100), f("exampleBuySignature", SIG.fRoundTripBuy), f("exampleSellSignature", SIG.fRoundTripSell)],
    observedAt: T_PHASE4B,
    eventTime: "2026-10-09T16:56:39Z",
    signature: SIG.fRoundTripBuy,
    slot: SIG_SLOT.fRoundTripBuy,
    addresses: [CLMM_F.poolAddress, WALLET.fTrader1, WALLET.fTrader2, WALLET.fTrader3],
    limits: [ROUNDED, "25 dernières transactions du pool seulement", "seul l'exemple le plus gros est ancré par signature"],
  });
  const volInd = add("ind:fVolume", {
    mint: MINT.F,
    type: "round_trip_volume",
    source: "helius",
    status: "INDICATION",
    summary: "Le volume 24 h affiché par DEX Screener est reconstitué par ces allers-retours (écart < 0,2 %)",
    facts: [f("roundTripUsdc", Math.round(usdcLegs * 100) / 100), f("dexVolumeH24", DEX[MINT.F]!.volumeH24)],
    observedAt: T_PHASE4B,
    basedOn: [roundTrips, ids[`dex:${MINT.F}`]!],
    limits: ["les allers-retours n'impliquent pas un changement de position nette: l'intention reste inconnue"],
  });
  add("hyp:fAutomation", {
    mint: MINT.F,
    type: "round_trip_volume",
    source: "helius",
    status: "HYPOTHESIS",
    summary: "Ces cycles sont programmés (automatisation), pour produire du volume ou par market-making",
    facts: [f("statement", "scheduled_round_trips")],
    observedAt: T_PHASE4B,
    basedOn: [volInd],
    limits: ["intention non établie", "aucune conclusion de manipulation"],
  });
  const f1 = add("fund:fLp", {
    mint: MINT.F,
    type: "funding_link",
    source: "helius",
    status: "FACT",
    summary: "Le minteur de F a financé (0,1 SOL) le wallet propriétaire de la position",
    facts: [f("from", WALLET.fMinter), f("to", WALLET.fLpOwner), f("sol", 0.1)],
    observedAt: T_PHASE4B,
    eventTime: "2026-07-04T04:15:02Z",
    signature: SIG.fLpOwnerFunding,
    slot: SIG_SLOT.fLpOwnerFunding,
    addresses: [WALLET.fMinter, WALLET.fLpOwner],
    limits: [ROUNDED],
  });
  const f2 = add("tx:fImpostor", {
    mint: MINT.F,
    type: "transaction",
    source: "helius",
    status: "FACT",
    summary: "Le wallet propriétaire de la position a minté un token nommé « BEP20-USDT » (autres: XLM, XRP, ZEC)",
    facts: [f("minter", WALLET.fLpOwner), f("tokenName", "BEP20-USDT"), f("amount", 209999999)],
    observedAt: T_PHASE4B,
    eventTime: "2026-07-04T04:25:25Z",
    signature: SIG.fImpostorMint,
    slot: SIG_SLOT.fImpostorMint,
    addresses: [WALLET.fLpOwner],
    limits: [ROUNDED, "nom lu dans le libellé parsé de Helius"],
  });
  const cluster = add("ind:fCluster", {
    mint: MINT.F,
    type: "identity_claim",
    source: "helius",
    status: "INDICATION",
    summary: "F fait partie d'une série de tokens portant des noms d'actifs connus, créés par un même cluster de wallets",
    facts: [f("clusterWallets", 2), f("namedAfter", "Gensyn,BEP20-USDT,XLM,XRP,ZEC")],
    observedAt: T_PHASE4B,
    basedOn: [f1, f2],
    limits: ["cluster établi par financement et proximité temporelle, pas par un lien unique"],
  });
  add("hyp:fImpersonation", {
    mint: MINT.F,
    type: "identity_claim",
    source: "helius",
    status: "HYPOTHESIS",
    summary: "F imite le nom du token Gensyn sans en être l'émission officielle",
    facts: [f("statement", "name_imitation_possible")],
    observedAt: T_PHASE4B,
    basedOn: [cluster],
    limits: ["l'identité officielle n'a pas pu être confirmée ni infirmée", "aucune conclusion d'intention"],
  });
  add("id:F", {
    mint: MINT.F,
    type: "identity_claim",
    source: "helius",
    status: "UNVERIFIED",
    summary: "Identité officielle du token F (Gensyn)",
    facts: [],
    observedAt: T_PHASE4B,
    missing: ["adresse officielle publiée par la fondation Gensyn", "lien entre E3UoKyex… et la fondation"],
    limits: ["les sources publiques consultées décrivent la vente sur Ethereum, sans token Solana"],
  });

  return { ledger, ids };
}
