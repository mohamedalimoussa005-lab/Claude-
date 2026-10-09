/**
 * Addresses and signatures read during DETECTIVE Phases 4 and 4B (Helius MCP, read-only,
 * and the public Solana RPC). Every signature below is validated by the tests
 * (format) and was re-checked against the public RPC when the fixtures were written.
 */

/** The seven contracts found in the ten X posts. */
export const MINT = {
  A: "CRvwxL33afPjBvmneJfz9pvLUt293XaZScxyFgzQMH5K", // Cl*nker (pump.fun)
  B: "7dCkdo2stVFNkXeyvkdQ82UhNJatwyaWFNve56kA28hj", // Cl*nker (rapidLaunch / Raydium)
  C: "AUd3rULBqpeUMUcoguBc8afg68g2hjj7SegB9AJsKCyQ", // QUANTUM
  D: "5b4n12eHotCTYxktAkKcD6xhakzoAnwZJJad8f8fpump", // FOXTILKI
  E: "GoADAwux19tGxb3W4ykPzZz8p5JCSYaxBRpuW7s9pump", // OCTO
  F: "47fwKU1UvbtatYoFYp7ThLkYjqBudAv8UbuhBLf2CK4G", // "Gensyn" / AI
  G: "sr7K3Pa6kGnwvu73q8ySB4onA4SrRMNL7B7rS6Xpump", // ALON
} as const;

export const WALLET = {
  aCreator: "4LBEBNefj5e8BJbL1xdvoYQQHEPzTK14pWSrgoAkAPe2",
  aRecipient1: "2A9C7BUMSV7aRrccS3Rc1CA2LKkhbDsptymPQTFAEjMt",
  aRecipient2: "4f5s927ybxjQc7Qe8C3NnBMWrCSURCSZmWB6Fvtt3Nf4",
  aRecipient3: "5wpwSkS6NXq4eGsTXXm8Dw55zeCrAX13xvixZkd9Qk9K",
  aFunder: "AreSXNRAsnwrKaQvg2H5trpQNqfprRPT62Y5EDU5h7xf",
  aFunderLookalike: "AreSKbbW9vQkVvMTk9utpPMEUQjhE2Djp8YGHgD5h7xf",
  aCreatorLookalike: "4LBEuSH4taQo2CGipWdYyWsBmayqFCPZSMFFC8ZdAPe2",
  aRecipient1Funder: "5GFV4y1SimMEjaoL9D3mkgx8zPYA4HvP86QQFeaRZZGR",
  bFirstTxPayer: "HF2EGxkKXRhdR93ZN5fY925PpecZDwRfKwhag6mvFMLW",
  bCosigner1: "F58LFGbv7wCEbsMkHZZqRmESc5KVVsp7A8iLCb4U7zdr",
  bCosigner2: "DsPd3d75roRt4wmWbe2XNAFGsqPfDSx2kqAHwky3RE6D",
  bCosigner3: "HrhUPLh8azcGE2ESpr93SU4vkRJ4bBS4uUBHac7mPEBd",
  bFeeAuthority: "5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD",
  bMetadataAuthority: "WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh",
  bQuoteToken: "Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw",
  cCreator: "Hgh3RrW6FALgtn97yFGri9UNmCFgXoZ9h5PNNMdrTpv",
  cFunder: "Dv6EmvtDNakvw8QNb4LtRn1YeiQbALi5CBbLzNrKFi1T",
  cSniper: "8RvtT8189KpAq5MkXGVHFn6LdZpxq9PkvDeAvs1g5Yj4",
  cSniperFunders: [
    "2LSncYjJrRsorTTG7UeTia9rmGo8pw8JtaAoYbq7CV5F",
    "6Weygqd9fBi3TnBkPwnDeUrGkTd83RCFPL7E6sc2EjSW",
    "Fhbh1DTUDKt6qu9zVg8Q5VgnZa1WWWbxBxG6pCoJoggA",
    "9pMiAWZ5QQbDsZkEiBq7EQGmZQzZRDKDPk4UAeMMp2Wx",
  ],
  fMinter: "E3UoKyex8msmNMNH1yd2X6w1Z6zQ9uaqGwxtqp2XQpZT",
  fLpOwner: "Hhc9gBeH3sZpeCyoJkVeSWXFFkn486hBpivfMdd3QQwB",
  fEarlyHolder: "3QG3aFvShbd6SxN3SdPowYQbokfReLGV6L141kMJQoLc",
  fTrader1: "8RvqEo9pqTmzhPbaEcnENY9WXJdRqHFWQVFqKA7QCCs5",
  fTrader2: "J2MFHpjZWp6e6tkFXtfF1qQQqBP57yfQv8WnyJGEwgxN",
  fTrader3: "39aDuA7Dnm2fKnmsr7PD7hvTAGEaN1yxkiHDuqSneJsR",
} as const;

export const SIG = {
  aCreate: "59spnG8HkLxiGeSSubh4nwEi8R76gcDyaB9dZ9zRsKtQo2TAXQp45kkiDKVisS9sZddXLYb5b9JZNNotNTUaQvTo",
  aRecipient1: "5FqS4tz1ZSMHcnfLhXtXwe232xcggXY8pVSM9p5tN1tz45ndQxrxPcZxd4Mx5R9Hg9t43xqcdn4XWdEKzFtTPaiq",
  aRecipient2: "21BL2Tyi8Ko1V37VsGhqFrrg1cAr36eHNzRCJuyfKrJAp9U6SMHnAmRdEr7nuo4CpjhTaS9dJowhjVr3y9eWmxsh",
  aRecipient3: "2S9F7HR3wQReJ1ZUsu79wua4TZS6xsuq8BwWdVbUwdS7X9iyyJJuCZtVnZcrjdZwckPPAz4yN5oBy4wHwfCQHFD7",
  aCreatorFundsRecipient2: "29CRF3K3TVWubnkJZ7MNh91maqqfhGaVCWjKUYfcE6anNbuFJZELsx5y5Y753b9XxmrFKd3VKwiZWja5Bxqz7cXE",
  aFunderFundsRecipient3: "57m7tcaVwkywPECL5UwrL8wnfdY4hJADvQ9WDzBvxk1V1XUsvZs5sngwcJfKs8mkwKEbD1KiGrLdmutSxAhsQQdm",
  aFunderFundsCreator: "3zsmGMimfHkEynxJjkMx56iZEm5NJbDwjJkos8ds1Zkkd8pBH9ryc8wAuU7S9j4mt1cD95UwZEKt8ahqQuPy2Hq7",
  aLookalikeDust: "3PNjFUZDDku54gACG1kR9Bc9YRZBumo2eztxEVmLEB7XhWm8JQzqrGHLHJEVDYq3BvSzoMjNYrNCRJwWz27BoL5b",
  bFirstTx: "3ceQvBUUb2xJciivrSDE6gv6QAL9Q4u8xz9DAkgMtdemDrMnhSyxMJePAfjgUypiw8HPXz1WF43B9vDR9x72tmdh",
  cCreate: "4gD9b9wbsgEoDaWzVdYW2Tdxm1BcZngMXzicTSGpd4ncCFLZRbez2CGyXowrcfUmw6ZEFoBKcrD5uuT8zaZjsmHF",
  cSniperBuy: "5WHV9tf1GUZwbexpaMfKqMkPgRr5PKmpam7qQVQQVUnKpaj7xKNCZBTMLD2FGj1zHvfu8VE8AJUvNCaQ9zzJjMWX",
  cFunding: "3teuEbUJ6dJog2BJNTCuTn5QtbssgS3oFJY8CyJYmP2xiEGMjr4jzD2njCrfJjdBksnG4UhP4JL6gdFWcrzbxnGy",
  cCreatorSell: "Luxzhe3RBWGpqsQYNd28QND5bGsY7CtuQEQ62oXcsDmCkcLTCQGoSYpTvmfL8dQN3yxrv22dYZvr6MccCDd3A2x",
  cReturn: "644DgWJSEUK61tBZdx4wTngZrCuYVyrugMHGDrrArPmHNhDogDAcWKyW5261giSDShDzwxhtMjZpnDQgQVy19Rki",
  cSniperFunding1: "2Sse6utj3H6PPLEhwarBRVP5VVEw1TE7dHGGBALbDy5htPkayr9BSAR1uXHeW31eQKCdha9WR7Qd9dSGiQbqxQtd",
  fMint: "5ZLXyacTujDFPcy11g3acMVEC4myeSen7xDYyDBXzMu2uFanSArSEihAi4tT93PVWfF6MH2Dk1tQcVBGCNvGHrSq",
  fPoolCreate: "67ABf9p3yD22wu3C7rPSMHc3rzFvcwpxg1zbf4Z2VDZXCWHuXaTBmU5cSyX9ZxLPXwAj6cLJURV2dY8sSQsAmASp",
  fRoundTripBuy: "5ycDHE212eUwoa3k6Duoi7HouSx77Fp7VptZzfXHNhXDdn7Wk7rdY8DjrSmYW9hTdn6K54psPJjERC2ggY5ZFRaw",
  fRoundTripSell: "4dvvHLw3f5UohkiwU42dMpWwMhBs47zezUFP22u6CWupHKjoMLPza7bGkYP24SfV1gdGD7njYaXJ36W7FvdEfGGB",
  fLpOwnerFunding: "kT8GyJKHB19E8JoajTuKZQ13rU8MX1estzuEerxwQTpL1phWtMbgFXKTFbC6bfwYjVTbQadamrEx9tVGH8MGUu1",
  fImpostorMint: "2metjP34YgKMDbQziZxVKvxt5WQkk8SN3PNkhjoenXPv8bhtRZFkgSMzUHmW5PmurifYiX98ZRS7CguMUnZDgH1j",
} as const;

/** Round trips on the F pool during the 24 h before the DEX Screener snapshot (Phase 4B). USDC legs. */
export const F_ROUND_TRIPS = {
  /** Large cycles: [buy USDC, sell USDC]. */
  large: [
    [11202, 11200.8574],
    [10321, 10319.9473],
    [10420, 10418.9372],
    [10010, 10008.979],
  ],
  /** ~41 USDC cycles (three). */
  medium: [
    [41, 40.9958],
    [41, 40.9958],
    [41, 40.9958],
  ],
  /** ~0.156 USDC cycles (three). */
  tiny: [
    [0.1564, 0.156368],
    [0.1564, 0.156368],
    [0.1564, 0.156368],
  ],
} as const;

/** Pool balances read with Helius getTokenBalances (Phase 4). */
export const POOL_BALANCES = {
  A: { sol: 2.81657, tokens: 878546115.763844 },
  C: { sol: 64.548079, tokens: 255239842.79972 },
  F: { usdc: 22.723549, tokens: 993940005.369926 },
} as const;

/** Slots of the signatures above, confirmed with getSignatureStatuses on the public RPC when the fixtures were written. */
export const SIG_SLOT: Record<keyof typeof SIG, number> = {
  aCreate: 454855402,
  aRecipient1: 454855402,
  aRecipient2: 454855402,
  aRecipient3: 454855402,
  aCreatorFundsRecipient2: 416265163,
  aFunderFundsRecipient3: 358953023,
  aFunderFundsCreator: 391784363,
  aLookalikeDust: 416265248,
  bFirstTx: 454855349,
  cCreate: 454769379,
  cSniperBuy: 454769379,
  cFunding: 454767396,
  cCreatorSell: 454769863,
  cReturn: 454770045,
  cSniperFunding1: 445030781,
  fMint: 430091134,
  fPoolCreate: 430105936,
  fRoundTripBuy: 454933180,
  fRoundTripSell: 454933274,
  fLpOwnerFunding: 430661532,
  fImpostorMint: 430663081,
};
