import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLiquidity } from "../src/detective/liquidity.ts";
import { Meter, budgeted } from "../src/detective/meter.ts";
import { resolveToken } from "../src/detective/resolve.ts";
import { ALL_TICKS, MINTS, dexPairs, fakeDex, fakeRpc, fixtureAccounts } from "./helpers/detective.ts";

async function liquidityOf(key: "A" | "B" | "C" | "F", accountsOverride: Record<string, { owner: string; data: string } | null> = {}) {
  const res = await resolveToken(fakeDex({ [MINTS[key]]: dexPairs(key) }), MINTS[key]);
  const rpc = fakeRpc({ accounts: { ...fixtureAccounts, ...accountsOverride }, tickArrays: ALL_TICKS });
  const limits: string[] = [];
  const out = await buildLiquidity(rpc, res, (t) => limits.push(t), () => Date.parse("2026-10-12T10:00:00Z"));
  return { out, rpc, limits };
}

const askUsd = (d: NonNullable<Awaited<ReturnType<typeof liquidityOf>>["out"]["depth"]>, bps: number) => d.ask.find((p) => p.impactBps === bps)!;
const bid = (d: NonNullable<Awaited<ReturnType<typeof liquidityOf>>["out"]["depth"]>, bps: number) => d.bid.find((p) => p.impactBps === bps)!;

test("F (Raydium CLMM, USDC): buy side is deep, sell side is almost empty — read live through the same path as the CLI", async () => {
  const { out, rpc } = await liquidityOf("F");
  const d = out.depth!;
  assert.equal(out.liquidity.status, "ok");
  assert.equal(out.liquidity.data!.venue.kind, "clmm");
  assert.ok(askUsd(d, 100).input!.usd! > 900_000 && askUsd(d, 100).input!.usd! < 945_000, `ask +1 % ${askUsd(d, 100).input!.usd}`);
  assert.equal(bid(d, 100).reached, false);
  assert.ok(bid(d, 100).output!.usd! < 1.5, "the sell capacity is about one dollar");
  assert.equal(d.supplySells.find((t) => t.label.includes("5%"))!.ok, false);
  const rt1000 = d.roundTrips.find((r) => r.usd === 1000)!;
  assert.ok(rt1000.ok && rt1000.lossPct! < 0.05);
  // the sell-side finding says it plainly
  assert.ok(out.liquidity.findings.some((f) => f.level === "FAIT" && f.text.includes("non atteignable")));
  assert.deepEqual(rpc.calls.map((c) => c.method), ["getMultipleAccounts", "getProgramAccounts", "getMultipleAccounts", "getEpochInfo"], "4 reads: pool, tick arrays, dependent accounts, epoch");
});

test("B (Raydium CP-Swap, Token-2022 taxes, memecoin quote): fees, taxes and round-trip loss are in the numbers", async () => {
  const { out } = await liquidityOf("B");
  const d = out.depth!;
  assert.equal(out.liquidity.data!.venue.kind, "cpmm");
  assert.ok(askUsd(d, 100).input!.usd! > 40 && askUsd(d, 100).input!.usd! < 52);
  const loss = d.roundTrips.find((r) => r.usd === 1000)!.lossPct!;
  assert.ok(loss > 5 && loss < 7.5, `round trip loss ${loss}`);
  assert.ok(out.liquidity.findings.some((f) => f.text.includes("Taxe de transfert Token-2022")));
  assert.ok(out.liquidity.findings.some((f) => f.level === "FAIT" && f.text.startsWith("Frais:")));
});

test("A and C (PumpSwap, closed-source program): results are INDICE, never FAIT, and the boost is disclosed", async () => {
  for (const k of ["A", "C"] as const) {
    const { out } = await liquidityOf(k);
    assert.equal(out.liquidity.data!.venue.kind, "pumpswap");
    const depthLines = out.liquidity.findings.filter((f) => f.text.startsWith("Profondeur"));
    assert.ok(depthLines.length >= 8 && depthLines.every((f) => f.level === "INDICE"), k);
    assert.ok(out.liquidity.findings.some((f) => f.text.includes("code du programme n'est pas public")));
  }
  const a = (await liquidityOf("A")).out.depth!;
  assert.ok(a.info.fees.some((f) => f.includes("125 bps")));
  assert.ok(a.info.fees.some((f) => /boosted|virtual/i.test(f)));
});

test("simulations of exits: sizes, supply sells and round trips are all present with their disclaimer", async () => {
  const { out } = await liquidityOf("C");
  const text = out.exits.findings.map((f) => f.text).join("\n").replace(/[\u202f\u00a0]/g, " ");
  for (const label of ["50", "100", "500", "1 000", "10 000"]) assert.ok(text.includes(`Aller-retour immédiat de ${label}`) || text.includes(label), label);
  assert.match(text, /Vente — vente de 5 % de l'offre/);
  assert.match(text, /Simulation sur un état figé du pool: ni une cotation ni une garantie d'exécution/);
  assert.equal(out.exits.data!.depth!.roundTrips.length, 5);
});

test("pump.fun bonding curve before migration is NON SIMULÉ with its reason, and DEX Screener's number is labelled third-party", async () => {
  const { out } = await liquidityOf("A", { [fixtureKey("A")]: { owner: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", data: "AAAA" } });
  assert.equal(out.liquidity.status, "unsupported");
  assert.equal(out.exits.status, "unsupported");
  assert.ok(out.liquidity.findings.some((f) => f.level === "NON SIMULÉ" && f.text.includes("courbe de bonding pump.fun avant migration")));
  assert.ok(out.liquidity.findings.some((f) => f.level === "INDICE" && f.text.includes("déclarée par DEX Screener (tiers")));
  assert.ok(out.exits.findings.every((f) => f.level === "NON SIMULÉ"));
  assert.equal(out.depth, null);
});

function fixtureKey(k: "A" | "B" | "C" | "F"): string {
  return { A: "D6dM5QMnHh3J3QruXmCs6Qrxnin8SfvvjAB94zkL12RB", B: "BDSF6GGGAshcqKizpoyRrtHonfvtSwKDz5gov9BYZ3De", C: "AEz2V3qgw2Piz7aC58x9Bob7TR8Cc3LwEJ4MQCNbRsh3", F: "57rXsAM2DAoyzbbcwHqGMxsjxC2X4EjBEhJ6oWJ4yL1P" }[k];
}

test("unsupported venues (Raydium AMM v4, unknown program, missing account, no pool) are NON SIMULÉ with a reason", async () => {
  const v4 = await liquidityOf("B", { [fixtureKey("B")]: { owner: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", data: "AAAA" } });
  assert.match(v4.out.liquidity.data!.venue.reason!, /Raydium AMM v4/);
  const unk = await liquidityOf("B", { [fixtureKey("B")]: { owner: "SomeUnknownProgram1111111111111111111111111", data: "AAAA" } });
  assert.match(unk.out.liquidity.data!.venue.reason!, /programme du pool inconnu/);
  const missing = await liquidityOf("B", { [fixtureKey("B")]: null });
  assert.match(missing.out.liquidity.data!.venue.reason!, /introuvable/);
  const res = await resolveToken(fakeDex({ [MINTS.A]: [] }), MINTS.A);
  const none = await buildLiquidity(fakeRpc(), res, () => {});
  assert.equal(none.liquidity.status, "unsupported");
  assert.match(none.liquidity.data!.venue.reason!, /aucun pool listé/);
  assert.equal(none.liquidity.data!.declaredByDexScreener, null);
});

test("a corrupt or inconsistent pool snapshot is reported, never simulated", async () => {
  const { out } = await liquidityOf("B", { [fixtureKey("B")]: { owner: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", data: "AAAA" } });
  assert.equal(out.liquidity.status, "unsupported");
  assert.match(out.liquidity.data!.venue.reason!, /lecture ou simulation du pool impossible/);
  assert.equal(out.depth, null);
});

test("budget exhaustion during the liquidity read is recorded as a limit and the section says so", async () => {
  const res = await resolveToken(fakeDex({ [MINTS.F]: dexPairs("F") }), MINTS.F);
  const meter = new Meter("rapide", 2, 60_000);
  const rpc = budgeted(fakeRpc({ accounts: fixtureAccounts, tickArrays: ALL_TICKS }), meter);
  const limits: string[] = [];
  const out = await buildLiquidity(rpc, res, (t) => limits.push(t));
  assert.equal(out.liquidity.status, "unsupported");
  assert.match(out.liquidity.data!.venue.reason!, /budget d'appels RPC atteint \(2\)/);
  assert.ok(limits.some((l) => l.includes("budget d'appels")));
  assert.ok(out.exits.findings.every((f) => f.level === "NON SIMULÉ"));
});

test("without a quote-token USD price the USD fields are null, not invented", async () => {
  const res = await resolveToken(fakeDex({ [MINTS.F]: dexPairs("F", { priceNative: undefined }) }), MINTS.F);
  const out = await buildLiquidity(fakeRpc({ accounts: fixtureAccounts, tickArrays: ALL_TICKS }), res, () => {});
  assert.equal(out.depth!.quote.usdPerQuote, null);
  assert.equal(out.depth!.ask[0]!.input!.usd, null);
  assert.ok(out.exits.findings.some((f) => f.text.includes("n/a")));
});
