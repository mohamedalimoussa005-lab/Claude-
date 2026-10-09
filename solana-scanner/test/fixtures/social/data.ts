/**
 * Local fixtures for the Evidence Ledger tests. NO network call.
 *
 * Extracted on 2026-10-09 from read-only observations made during DETECTIVE
 * Phases 2, 3, 4 and 4B (X posts via a single Apify run, DEX Screener public API,
 * Solana public RPC, Helius). Post texts are kept as short excerpts: they are
 * untrusted data, never instructions. Nothing here is a trading signal.
 */

export interface PostFixture {
  n: number;
  id: string;
  author: string;
  createdAt: string;
  url: string;
  followers: number;
  authorCreatedAt: string;
  blueVerified: boolean;
  likes: number;
  retweets: number;
  views: number;
  contracts: string[];
  cashtags: string[];
  linkHosts: string[];
  excerpt: string;
}

export interface DexFixture {
  symbol: string;
  name: string;
  dex: string;
  pairAddress: string;
  pairLabels: string[];
  quoteSymbol: string;
  quoteAddress: string;
  liquidityUsd: number;
  marketCap: number;
  fdv: number;
  volumeH24: number;
  buysH24: number;
  sellsH24: number;
  priceChangeH24: number | null;
  pairCreatedAt: string;
  websites: string[];
  socials: string[];
}

export interface HolderFixture {
  label: string;
  supply: number;
  tokenAccounts: number;
  holders: number;
  poolOwner: string;
  poolPct: number;
  nonPoolTop1Pct: number;
  nonPoolTop5Pct: number;
  nonPoolTop10Pct: number;
  nonPoolTop20Pct: number;
  observedAt: string;
}

export interface MintRpcFixture {
  label: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supplyRaw: string;
  decimals: number;
  extensionTypes: number[];
  accountSize: number;
  contextSlot: number;
  transferFee: { bps: number; authority: string; withdrawAuthority: string; withheldRaw: number } | null;
  observedAt: string;
}

export interface ClmmFixture {
  poolAddress: string;
  liquidity: string;
  sqrtPriceX64: string;
  tickCurrent: number;
  tickSpacing: number;
  positionAddress: string;
  positionNft: string;
  tickLower: number;
  tickUpper: number;
  positionLiquidity: string;
  observedAt: string;
}

export interface SlotFixture {
  signature: string;
  slot: number;
  blockTime: string;
  feePayer: string;
}

export const POSTS_OBSERVED_AT = "2026-10-09T11:50:17Z";
export const POSTS: PostFixture[] = [
  {
    "n": 1,
    "id": "2108524094501093851",
    "author": "Kionsaso2",
    "createdAt": "2026-10-09T11:44:53Z",
    "url": "https://x.com/Kionsaso2/status/2108524094501093851",
    "followers": 111,
    "authorCreatedAt": "2026-04-29T11:55:30Z",
    "blueVerified": true,
    "likes": 0,
    "retweets": 0,
    "views": 2,
    "contracts": [],
    "cashtags": [],
    "linkHosts": [
      "github.com"
    ],
    "excerpt": "i think i really found the only and first Qunatum mascot his name is XESUMA. he is in the "
  },
  {
    "n": 2,
    "id": "2108523964956114971",
    "author": "bitecong",
    "createdAt": "2026-10-09T11:44:22Z",
    "url": "https://x.com/bitecong/status/2108523964956114971",
    "followers": 36974,
    "authorCreatedAt": "2012-09-16T05:44:49Z",
    "blueVerified": true,
    "likes": 0,
    "retweets": 0,
    "views": 267,
    "contracts": [
      "7dCkdo2stVFNkXeyvkdQ82UhNJatwyaWFNve56kA28hj"
    ],
    "cashtags": [],
    "linkHosts": [],
    "excerpt": "🤖 AI Signal (SOL) Cl*nker CA: 7dCkdo2stVFNkXeyvkdQ82UhNJatwyaWFNve56kA28hj Cl*nker is a So"
  },
  {
    "n": 3,
    "id": "2108523895661769204",
    "author": "MuskEraAlpnpw",
    "createdAt": "2026-10-09T11:44:05Z",
    "url": "https://x.com/MuskEraAlpnpw/status/2108523895661769204",
    "followers": 1028,
    "authorCreatedAt": "2011-02-19T01:37:13Z",
    "blueVerified": true,
    "likes": 0,
    "retweets": 0,
    "views": 1,
    "contracts": [
      "AUd3rULBqpeUMUcoguBc8afg68g2hjj7SegB9AJsKCyQ"
    ],
    "cashtags": [
      "$QUANTUM"
    ],
    "linkHosts": [],
    "excerpt": "🚀 $QUANTUM HITS 27X FROM MY CALL! 🔥 Another impressive milestone reached! 📈 27X from the o"
  },
  {
    "n": 4,
    "id": "2108523845032304943",
    "author": "1881Erdem",
    "createdAt": "2026-10-09T11:43:53Z",
    "url": "https://x.com/1881Erdem/status/2108523845032304943",
    "followers": 45136,
    "authorCreatedAt": "2021-01-14T23:11:59Z",
    "blueVerified": true,
    "likes": 0,
    "retweets": 0,
    "views": 135,
    "contracts": [
      "5b4n12eHotCTYxktAkKcD6xhakzoAnwZJJad8f8fpump"
    ],
    "cashtags": [
      "$BTC",
      "$ETH",
      "$PUMP"
    ],
    "linkHosts": [
      "web3.binance.com"
    ],
    "excerpt": "solana:5b4n12eHotCTYxktAkKcD6xhakzoAnwZJJad8f8fpump 318k'dan 15 milyon marketcap 50x 50 ka"
  },
  {
    "n": 5,
    "id": "2108523838531068319",
    "author": "Shelly87120880",
    "createdAt": "2026-10-09T11:43:52Z",
    "url": "https://x.com/Shelly87120880/status/2108523838531068319",
    "followers": 2468,
    "authorCreatedAt": "2020-04-15T12:35:27Z",
    "blueVerified": true,
    "likes": 0,
    "retweets": 1,
    "views": 1,
    "contracts": [
      "GoADAwux19tGxb3W4ykPzZz8p5JCSYaxBRpuW7s9pump"
    ],
    "cashtags": [
      "$OCTO",
      "$SOL"
    ],
    "linkHosts": [
      "memes-airdrop.netlify.app"
    ],
    "excerpt": "⚡ Looking into Octo Protocol $OCTO on Solana $SOL. This page gives crypto and memecoin fan"
  },
  {
    "n": 6,
    "id": "2108523833720516710",
    "author": "_bitblade",
    "createdAt": "2026-10-09T11:43:51Z",
    "url": "https://x.com/_bitblade/status/2108523833720516710",
    "followers": 6365,
    "authorCreatedAt": "2026-06-14T20:42:59Z",
    "blueVerified": true,
    "likes": 0,
    "retweets": 0,
    "views": 25,
    "contracts": [
      "CRvwxL33afPjBvmneJfz9pvLUt293XaZScxyFgzQMH5K"
    ],
    "cashtags": [],
    "linkHosts": [],
    "excerpt": "CA&gt;&lt; CRvwxL33afPjBvmneJfz9pvLUt293XaZScxyFgzQMH5K #solana #memecoin #memecoin1000x h"
  },
  {
    "n": 7,
    "id": "2108523757824548891",
    "author": "flinttrades_1",
    "createdAt": "2026-10-09T11:43:32Z",
    "url": "https://x.com/flinttrades_1/status/2108523757824548891",
    "followers": 575,
    "authorCreatedAt": "2022-01-13T12:18:59Z",
    "blueVerified": true,
    "likes": 1,
    "retweets": 0,
    "views": 24,
    "contracts": [
      "sr7K3Pa6kGnwvu73q8ySB4onA4SrRMNL7B7rS6Xpump"
    ],
    "cashtags": [
      "$ALON"
    ],
    "linkHosts": [],
    "excerpt": "$ALON sr7K3Pa6kGnwvu73q8ySB4onA4SrRMNL7B7rS6Xpump #Solana #Memecoin #Robinhood https://t.c"
  },
  {
    "n": 8,
    "id": "2108523543789281571",
    "author": "ImThat84499120",
    "createdAt": "2026-10-09T11:42:41Z",
    "url": "https://x.com/ImThat84499120/status/2108523543789281571",
    "followers": 1451,
    "authorCreatedAt": "2022-04-25T16:42:26Z",
    "blueVerified": true,
    "likes": 0,
    "retweets": 0,
    "views": 3,
    "contracts": [
      "47fwKU1UvbtatYoFYp7ThLkYjqBudAv8UbuhBLf2CK4G"
    ],
    "cashtags": [
      "$AI",
      "$SOL"
    ],
    "linkHosts": [
      "memes-airdrop.netlify.app"
    ],
    "excerpt": "🌊 Gensyn $AI joins the mix of Solana $SOL projects. Take a look at the airdrop and explore"
  },
  {
    "n": 9,
    "id": "2108523516119179315",
    "author": "MuskEraAlpnpw",
    "createdAt": "2026-10-09T11:42:35Z",
    "url": "https://x.com/MuskEraAlpnpw/status/2108523516119179315",
    "followers": 1028,
    "authorCreatedAt": "2011-02-19T01:37:13Z",
    "blueVerified": true,
    "likes": 0,
    "retweets": 0,
    "views": 8,
    "contracts": [
      "AUd3rULBqpeUMUcoguBc8afg68g2hjj7SegB9AJsKCyQ"
    ],
    "cashtags": [
      "$QUANTUM"
    ],
    "linkHosts": [],
    "excerpt": "🚀 24X FROM MY $QUANTUM CALL! 🔥 Another milestone hit! 📈 $QUANTUM is showing strong momentu"
  },
  {
    "n": 10,
    "id": "2108523432052949090",
    "author": "bitecong",
    "createdAt": "2026-10-09T11:42:15Z",
    "url": "https://x.com/bitecong/status/2108523432052949090",
    "followers": 36974,
    "authorCreatedAt": "2012-09-16T05:44:49Z",
    "blueVerified": true,
    "likes": 0,
    "retweets": 0,
    "views": 374,
    "contracts": [
      "CRvwxL33afPjBvmneJfz9pvLUt293XaZScxyFgzQMH5K"
    ],
    "cashtags": [],
    "linkHosts": [],
    "excerpt": "🤖 AI Signal (SOL) Cl*nker CA: CRvwxL33afPjBvmneJfz9pvLUt293XaZScxyFgzQMH5K Cl*nker has bee"
  }
];

export const DEX_OBSERVED_AT = "2026-10-09T18:23:53Z";
export const DEX: Record<string, DexFixture> = {
  "47fwKU1UvbtatYoFYp7ThLkYjqBudAv8UbuhBLf2CK4G": {
    "symbol": "AI",
    "name": "Gensyn",
    "dex": "raydium",
    "pairAddress": "57rXsAM2DAoyzbbcwHqGMxsjxC2X4EjBEhJ6oWJ4yL1P",
    "pairLabels": [
      "CLMM"
    ],
    "quoteSymbol": "USDC",
    "quoteAddress": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "liquidityUsd": 33901065.24,
    "marketCap": 34107735,
    "fdv": 34107735,
    "volumeH24": 84230.64,
    "buysH24": 11,
    "sellsH24": 11,
    "priceChangeH24": null,
    "pairCreatedAt": "2026-07-01T14:10:29Z",
    "websites": [],
    "socials": []
  },
  "5b4n12eHotCTYxktAkKcD6xhakzoAnwZJJad8f8fpump": {
    "symbol": "FOXTILKI",
    "name": "FOXTILKI",
    "dex": "pumpswap",
    "pairAddress": "Hv8dLseQCbGG1WKRDdVjiiSQYHHC5xDWeq9Jz5GqjJWg",
    "pairLabels": [],
    "quoteSymbol": "SOL",
    "quoteAddress": "So11111111111111111111111111111111111111112",
    "liquidityUsd": 51979.91,
    "marketCap": 293316,
    "fdv": 293316,
    "volumeH24": 5129.46,
    "buysH24": 57,
    "sellsH24": 20,
    "priceChangeH24": 2.06,
    "pairCreatedAt": "2026-08-23T20:29:32Z",
    "websites": [],
    "socials": []
  },
  "7dCkdo2stVFNkXeyvkdQ82UhNJatwyaWFNve56kA28hj": {
    "symbol": "Cl*nker",
    "name": "Cl*nker",
    "dex": "raydium",
    "pairAddress": "BDSF6GGGAshcqKizpoyRrtHonfvtSwKDz5gov9BYZ3De",
    "pairLabels": [
      "CPMM"
    ],
    "quoteSymbol": "ANTHROPIC",
    "quoteAddress": "Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw",
    "liquidityUsd": 21187.93,
    "marketCap": 51399,
    "fdv": 51399,
    "volumeH24": 1131348.61,
    "buysH24": 12390,
    "sellsH24": 8656,
    "priceChangeH24": 16.82,
    "pairCreatedAt": "2026-10-09T11:46:37Z",
    "websites": [],
    "socials": [
      "https://x.com/Bencookss/status/2108522673940607302"
    ]
  },
  "AUd3rULBqpeUMUcoguBc8afg68g2hjj7SegB9AJsKCyQ": {
    "symbol": "QUANTUM",
    "name": "QuantumCoin",
    "dex": "pumpswap",
    "pairAddress": "AEz2V3qgw2Piz7aC58x9Bob7TR8Cc3LwEJ4MQCNbRsh3",
    "pairLabels": [],
    "quoteSymbol": "SOL",
    "quoteAddress": "So11111111111111111111111111111111111111112",
    "liquidityUsd": 15916.27,
    "marketCap": 33927,
    "fdv": 33927,
    "volumeH24": 1143300.12,
    "buysH24": 13024,
    "sellsH24": 10486,
    "priceChangeH24": -23.46,
    "pairCreatedAt": "2026-10-09T05:26:45Z",
    "websites": [],
    "socials": [
      "https://x.com/QuantumCoin_sol"
    ]
  },
  "CRvwxL33afPjBvmneJfz9pvLUt293XaZScxyFgzQMH5K": {
    "symbol": "Cl*nker",
    "name": "Cl*nker",
    "dex": "pumpswap",
    "pairAddress": "D6dM5QMnHh3J3QruXmCs6Qrxnin8SfvvjAB94zkL12RB",
    "pairLabels": [],
    "quoteSymbol": "SOL",
    "quoteAddress": "So11111111111111111111111111111111111111112",
    "liquidityUsd": 2517.02,
    "marketCap": 2342,
    "fdv": 2342,
    "volumeH24": 136966.12,
    "buysH24": 1973,
    "sellsH24": 1901,
    "priceChangeH24": -94.65,
    "pairCreatedAt": "2026-10-09T11:43:39Z",
    "websites": [
      "https://otcdesks.cash/coin/CRvwxL33afPjBvmneJfz9pvLUt293XaZScxyFgzQMH5K"
    ],
    "socials": [
      "https://x.com/Bencookss/status/2108522673940607302"
    ]
  },
  "GoADAwux19tGxb3W4ykPzZz8p5JCSYaxBRpuW7s9pump": {
    "symbol": "OCTO",
    "name": "Octo Protocol",
    "dex": "pumpswap",
    "pairAddress": "3uXWc5dnrU6rz7t23PpJirZQnwfw9huq8LnNhorLXTK5",
    "pairLabels": [],
    "quoteSymbol": "SPYx",
    "quoteAddress": "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
    "liquidityUsd": 74335.56,
    "marketCap": 380481,
    "fdv": 380481,
    "volumeH24": 29823.73,
    "buysH24": 174,
    "sellsH24": 101,
    "priceChangeH24": -14.45,
    "pairCreatedAt": "2026-10-01T20:25:27Z",
    "websites": [
      "https://octoprotocol.io/"
    ],
    "socials": [
      "https://x.com/octoprotocol"
    ]
  },
  "sr7K3Pa6kGnwvu73q8ySB4onA4SrRMNL7B7rS6Xpump": {
    "symbol": "ALON",
    "name": "Alon Cohen",
    "dex": "pumpswap",
    "pairAddress": "FQmWczPBe1UbSTYLn23CVPLNMSc13r9cHpZh4s4tyYW8",
    "pairLabels": [],
    "quoteSymbol": "SOL",
    "quoteAddress": "So11111111111111111111111111111111111111112",
    "liquidityUsd": 14658.43,
    "marketCap": 33397,
    "fdv": 33397,
    "volumeH24": 141506.37,
    "buysH24": 1456,
    "sellsH24": 1200,
    "priceChangeH24": -23.83,
    "pairCreatedAt": "2026-10-09T11:14:20Z",
    "websites": [],
    "socials": [
      "https://x.com/aloncohenpump",
      "https://www.tiktok.com/@aloncohenpump"
    ]
  }
};

export const HOLDERS: Record<string, HolderFixture> = {
  "CRvwxL33afPjBvmneJfz9pvLUt293XaZScxyFgzQMH5K": {
    "label": "A",
    "supply": 931754698.349651,
    "tokenAccounts": 1205,
    "holders": 122,
    "poolOwner": "D6dM5QMnHh3J3QruXmCs6Qrxnin8SfvvjAB94zkL12RB",
    "poolPct": 93.21,
    "nonPoolTop1Pct": 1.08,
    "nonPoolTop5Pct": 3.27,
    "nonPoolTop10Pct": 4.54,
    "nonPoolTop20Pct": 5.66,
    "observedAt": "2026-10-09T18:55:25Z"
  },
  "7dCkdo2stVFNkXeyvkdQ82UhNJatwyaWFNve56kA28hj": {
    "label": "B",
    "supply": 999988089.17303,
    "tokenAccounts": 4130,
    "holders": 1061,
    "poolOwner": "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL",
    "poolPct": 22.73,
    "nonPoolTop1Pct": 3.62,
    "nonPoolTop5Pct": 14.0,
    "nonPoolTop10Pct": 21.77,
    "nonPoolTop20Pct": 30.47,
    "observedAt": "2026-10-09T18:55:30Z"
  },
  "AUd3rULBqpeUMUcoguBc8afg68g2hjj7SegB9AJsKCyQ": {
    "label": "C",
    "supply": 979048090.389471,
    "tokenAccounts": 3494,
    "holders": 887,
    "poolOwner": "AEz2V3qgw2Piz7aC58x9Bob7TR8Cc3LwEJ4MQCNbRsh3",
    "poolPct": 20.88,
    "nonPoolTop1Pct": 3.67,
    "nonPoolTop5Pct": 15.55,
    "nonPoolTop10Pct": 26.52,
    "nonPoolTop20Pct": 39.33,
    "observedAt": "2026-10-09T18:55:28Z"
  },
  "47fwKU1UvbtatYoFYp7ThLkYjqBudAv8UbuhBLf2CK4G": {
    "label": "F",
    "supply": 999998295.232355,
    "tokenAccounts": 45,
    "holders": 27,
    "poolOwner": "57rXsAM2DAoyzbbcwHqGMxsjxC2X4EjBEhJ6oWJ4yL1P",
    "poolPct": 99.39,
    "nonPoolTop1Pct": 0.57,
    "nonPoolTop5Pct": 0.6,
    "nonPoolTop10Pct": 0.61,
    "nonPoolTop20Pct": 0.61,
    "observedAt": "2026-10-09T18:55:23Z"
  }
};

export const MINTS_RPC: Record<string, MintRpcFixture> = {
  "CRvwxL33afPjBvmneJfz9pvLUt293XaZScxyFgzQMH5K": {
    "label": "A",
    "mintAuthority": null,
    "freezeAuthority": null,
    "supplyRaw": "931754698349651",
    "decimals": 6,
    "extensionTypes": [
      18,
      19
    ],
    "accountSize": 386,
    "contextSlot": 454964740,
    "transferFee": null,
    "observedAt": "2026-10-09T18:51:33Z"
  },
  "7dCkdo2stVFNkXeyvkdQ82UhNJatwyaWFNve56kA28hj": {
    "label": "B",
    "mintAuthority": null,
    "freezeAuthority": null,
    "supplyRaw": "999988089173030",
    "decimals": 6,
    "extensionTypes": [
      18,
      1,
      19
    ],
    "accountSize": 480,
    "contextSlot": 454964738,
    "transferFee": {
      "bps": 100,
      "authority": "5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD",
      "withdrawAuthority": "5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD",
      "withheldRaw": 855545949299
    },
    "observedAt": "2026-10-09T18:51:33Z"
  }
};

export const CLMM_F: ClmmFixture = {
  "poolAddress": "57rXsAM2DAoyzbbcwHqGMxsjxC2X4EjBEhJ6oWJ4yL1P",
  "liquidity": "1000962964985175",
  "sqrtPriceX64": "3406796276352063248",
  "tickCurrent": -33784,
  "tickSpacing": 1,
  "positionAddress": "8uJfmdb3YG9fadocADB2x3CatZS1Rh2tqTe3TmwhYVLh",
  "positionNft": "AZumsmfow8J2DLVxvZxnfBr4G5CFLbZV2HZ1qzsuqAzd",
  "tickLower": -33784,
  "tickUpper": -29732,
  "positionLiquidity": "1000962964985175",
  "observedAt": "2026-10-09T18:51:51Z"
};

/** Slot and block time read with getTransaction on the public Solana RPC (Phase 4B). */
export const SLOTS: Record<string, SlotFixture> = {
  "A_create": {
    "signature": "59spnG8HkLxiGeSSubh4nwEi8R76gcDyaB9dZ9zRsKtQo2TAXQp45kkiDKVisS9sZddXLYb5b9JZNNotNTUaQvTo",
    "slot": 454855402,
    "blockTime": "2026-10-09T11:39:29Z",
    "feePayer": "4LBEBNefj5e8BJbL1xdvoYQQHEPzTK14pWSrgoAkAPe2"
  },
  "A_r1": {
    "signature": "5FqS4tz1ZSMHcnfLhXtXwe232xcggXY8pVSM9p5tN1tz45ndQxrxPcZxd4Mx5R9Hg9t43xqcdn4XWdEKzFtTPaiq",
    "slot": 454855402,
    "blockTime": "2026-10-09T11:39:29Z",
    "feePayer": "2A9C7BUMSV7aRrccS3Rc1CA2LKkhbDsptymPQTFAEjMt"
  },
  "A_r2": {
    "signature": "21BL2Tyi8Ko1V37VsGhqFrrg1cAr36eHNzRCJuyfKrJAp9U6SMHnAmRdEr7nuo4CpjhTaS9dJowhjVr3y9eWmxsh",
    "slot": 454855402,
    "blockTime": "2026-10-09T11:39:29Z",
    "feePayer": "4f5s927ybxjQc7Qe8C3NnBMWrCSURCSZmWB6Fvtt3Nf4"
  },
  "A_r3": {
    "signature": "2S9F7HR3wQReJ1ZUsu79wua4TZS6xsuq8BwWdVbUwdS7X9iyyJJuCZtVnZcrjdZwckPPAz4yN5oBy4wHwfCQHFD7",
    "slot": 454855402,
    "blockTime": "2026-10-09T11:39:29Z",
    "feePayer": "5wpwSkS6NXq4eGsTXXm8Dw55zeCrAX13xvixZkd9Qk9K"
  },
  "B_first": {
    "signature": "3ceQvBUUb2xJciivrSDE6gv6QAL9Q4u8xz9DAkgMtdemDrMnhSyxMJePAfjgUypiw8HPXz1WF43B9vDR9x72tmdh",
    "slot": 454855349,
    "blockTime": "2026-10-09T11:39:15Z",
    "feePayer": "HF2EGxkKXRhdR93ZN5fY925PpecZDwRfKwhag6mvFMLW"
  },
  "C_b1": {
    "signature": "5WHV9tf1GUZwbexpaMfKqMkPgRr5PKmpam7qQVQQVUnKpaj7xKNCZBTMLD2FGj1zHvfu8VE8AJUvNCaQ9zzJjMWX",
    "slot": 454769379,
    "blockTime": "2026-10-09T05:15:38Z",
    "feePayer": "8RvtT8189KpAq5MkXGVHFn6LdZpxq9PkvDeAvs1g5Yj4"
  },
  "C_b4": {
    "signature": "2E7vQFTNxuQBSS8UDAjQG4DnoMioLkiB8Ya9W9oFG9SMSndtgSvzaXyGcZiP4MULo2Gvp8ULoS9EfgXAuGNqhtCx",
    "slot": 454769391,
    "blockTime": "2026-10-09T05:15:41Z",
    "feePayer": "8RvtT8189KpAq5MkXGVHFn6LdZpxq9PkvDeAvs1g5Yj4"
  },
  "C_b5": {
    "signature": "3BYctwddsmSR5SW8oaSbUnMtS78nUKXyXzDJULXDGk9Ff1Cf5ngGcws9Q2qPdQtRCAPAGkiiQBuakGUp9Q8SJ7bX",
    "slot": 454769395,
    "blockTime": "2026-10-09T05:15:42Z",
    "feePayer": "8RvtT8189KpAq5MkXGVHFn6LdZpxq9PkvDeAvs1g5Yj4"
  },
  "C_create": {
    "signature": "4gD9b9wbsgEoDaWzVdYW2Tdxm1BcZngMXzicTSGpd4ncCFLZRbez2CGyXowrcfUmw6ZEFoBKcrD5uuT8zaZjsmHF",
    "slot": 454769379,
    "blockTime": "2026-10-09T05:15:38Z",
    "feePayer": "Hgh3RrW6FALgtn97yFGri9UNmCFgXoZ9h5PNNMdrTpv"
  },
  "C_fund": {
    "signature": "3teuEbUJ6dJog2BJNTCuTn5QtbssgS3oFJY8CyJYmP2xiEGMjr4jzD2njCrfJjdBksnG4UhP4JL6gdFWcrzbxnGy",
    "slot": 454767396,
    "blockTime": "2026-10-09T05:06:50Z",
    "feePayer": "Dv6EmvtDNakvw8QNb4LtRn1YeiQbALi5CBbLzNrKFi1T"
  },
  "C_ret": {
    "signature": "644DgWJSEUK61tBZdx4wTngZrCuYVyrugMHGDrrArPmHNhDogDAcWKyW5261giSDShDzwxhtMjZpnDQgQVy19Rki",
    "slot": 454770045,
    "blockTime": "2026-10-09T05:18:36Z",
    "feePayer": "Hgh3RrW6FALgtn97yFGri9UNmCFgXoZ9h5PNNMdrTpv"
  },
  "C_sell": {
    "signature": "Luxzhe3RBWGpqsQYNd28QND5bGsY7CtuQEQ62oXcsDmCkcLTCQGoSYpTvmfL8dQN3yxrv22dYZvr6MccCDd3A2x",
    "slot": 454769863,
    "blockTime": "2026-10-09T05:17:48Z",
    "feePayer": "Hgh3RrW6FALgtn97yFGri9UNmCFgXoZ9h5PNNMdrTpv"
  }
};
