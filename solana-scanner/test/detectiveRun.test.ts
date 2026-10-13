import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { runDetective } from "../src/detective/run.ts";
import { ALL_TICKS, MINTS, dexPairs, fakeDex, fakeRpc, fixtureAccounts, stubCollect } from "./helpers/detective.ts";

const NOW = () => Date.parse("2026-10-12T10:00:00Z");
const noSleep = async () => {};
const rpcFor = () => fakeRpc({ accounts: fixtureAccounts, tickArrays: ALL_TICKS });

async function run(key: "A" | "B" | "C" | "F", mode: "rapide" | "standard" | "profond" = "rapide", over: Parameters<typeof runDetective>[0]["overrides"] = {}) {
  return runDetective({ mint: MINTS[key], mode, overrides: over }, { dex: fakeDex({ [MINTS[key]]: dexPairs(key) }), rpc: rpcFor(), now: NOW, collect: stubCollect, sleep: noSleep });
}

test("one address → one report with the ten sections, in the three modes", async () => {
  for (const mode of ["rapide", "standard", "profond"] as const) {
    const { report, markdown } = await run("F", mode);
    assert.equal(report.schema, "detective-report/1");
    assert.equal(report.mode, mode);
    assert.deepEqual(Object.keys(report.sections), ["identity", "creator", "firstBuyers", "funding", "liquidity", "exitSimulations", "repetitive", "social", "evidence", "synthesis"]);
    for (const h of ["Synthèse", "1. Identité du token", "2. Créateur et autorités", "3. Premiers acheteurs", "4. Financements et wallets liés", "5. Liquidité réelle", "6. Simulations de sortie", "7. Transactions répétitives", "8. Signaux sociaux disponibles", "9. Preuves et données inconnues", "Budget consommé"]) assert.ok(markdown.includes(`## ${h}`), `${mode}: ${h}`);
    assert.ok(report.budget.calls > 0 && report.budget.calls <= report.budget.maxCalls);
  }
});

test("the report is JSON-safe, has no hypothesis, no verdict and no score", async () => {
  const { report, markdown, ledger } = await run("A", "standard");
  assert.doesNotThrow(() => JSON.stringify(report));
  assert.equal(report.hypothesesEnabled, false);
  assert.ok(!ledger.all().some((e) => e.status === "HYPOTHESIS" || e.type === "coordination_assessment"));
  assert.doesNotMatch(markdown, /fraude avérée|arnaque|scam|rug pull|à acheter|achetez|vendez/i);
  assert.doesNotMatch(markdown, /probabilité de fraude/i);
  assert.ok(!("score" in report) && !/Opportunity [0-9]|Risk [0-9]{1,3}\/100/.test(markdown), "no scanner score is mixed in");
  assert.match(markdown, /Aucun verdict n'est émis/);
  for (const f of Object.values(report.sections).flatMap((s) => s.findings)) assert.ok(["FAIT", "INDICE", "INCONNU", "NON SIMULÉ"].includes(f.level), f.level);
});

test("the ledger records the pool snapshot, the mint state and the DEX Screener read with their statuses", async () => {
  const { ledger } = await run("F");
  const types = ledger.all().map((e) => `${e.type}:${e.status}:${e.derivation}`);
  assert.ok(types.includes("mint_state:FACT:observed"));
  assert.ok(types.includes("dex_pair:FACT:observed"));
  assert.ok(types.includes("pool_state:FACT:observed"));
  assert.ok(types.includes("liquidity_depth:FACT:computed"));
  const pump = (await run("A")).ledger.all().find((e) => e.type === "liquidity_depth")!;
  assert.equal(pump.status, "INDICATION", "PumpSwap formulas are not from public program source");
});

test("exit simulations and unsupported pools show through the report (F simulated, bonding curve NON SIMULÉ)", async () => {
  const ok = await run("F");
  assert.equal(ok.report.sections.liquidity.status, "ok");
  const curve = await runDetective(
    { mint: MINTS.F, mode: "rapide" },
    { dex: fakeDex({ [MINTS.F]: dexPairs("F", { dexId: "pumpfun" }) }), rpc: fakeRpc({ accounts: { ...fixtureAccounts, "57rXsAM2DAoyzbbcwHqGMxsjxC2X4EjBEhJ6oWJ4yL1P": { owner: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", data: "AAAA" } } }), now: NOW, collect: stubCollect, sleep: noSleep },
  );
  assert.equal(curve.report.sections.liquidity.status, "unsupported");
  assert.match(curve.markdown, /NON SIMULÉ/);
  assert.match(curve.markdown, /courbe de bonding pump\.fun avant migration/);
  assert.ok(curve.report.sections.synthesis.findings.some((f) => f.level === "NON SIMULÉ"));
});

test("a token without DEX Screener pool, a DEX outage and an invalid address are all handled", async () => {
  const none = await runDetective({ mint: MINTS.A, mode: "rapide" }, { dex: fakeDex({ [MINTS.A]: [] }), rpc: rpcFor(), now: NOW, collect: stubCollect, sleep: noSleep });
  assert.equal(none.report.sections.liquidity.status, "unsupported");
  assert.match(none.markdown, /aucun pool/);
  const down = await runDetective({ mint: MINTS.A, mode: "rapide" }, { dex: fakeDex({}), rpc: rpcFor(), now: NOW, collect: stubCollect, sleep: noSleep });
  assert.ok(down.report.budget.limitsReached.includes("DEX Screener indisponible"));
  assert.equal(down.report.sections.social.findings[0]!.level, "INCONNU");
  await assert.rejects(() => runDetective({ mint: "nope", mode: "rapide" }, { dex: fakeDex({}), rpc: rpcFor() }), /adresse de token invalide/);
});

test("the call budget is enforced end to end and every limit reached is written in the report", async () => {
  const r = await run("F", "rapide", { maxCalls: 2 });
  assert.ok(r.report.budget.calls <= 2);
  assert.ok(r.report.budget.limitsReached.some((l) => l.includes("budget d'appels RPC atteint (2)")));
  assert.match(r.markdown, /Limites atteintes : .*budget d'appels RPC atteint \(2\)/);
  assert.ok(r.report.sections.synthesis.findings.some((f) => f.level === "INCONNU" && f.text.includes("Limites atteintes")));
});

test("an on-chain collection failure leaves the other sections intact and says what is unknown", async () => {
  const r = await runDetective({ mint: MINTS.F, mode: "rapide" }, { dex: fakeDex({ [MINTS.F]: dexPairs("F") }), rpc: rpcFor(), now: NOW, collect: async () => { throw new Error("RPC en panne"); }, sleep: noSleep });
  assert.ok(r.report.sections.identity.unknowns.some((u) => u.includes("RPC en panne")));
  assert.equal(r.report.sections.liquidity.status, "ok");
});

test("isolation: the existing scoring, final assessment, wallets, onchain, outcomes, api, history, rpc, ui and server code never import DETECTIVE", () => {
  const forbidden = /from\s+["'][^"']*\/detective\//;
  for (const dir of ["../src/scoring/", "../src/final/", "../src/wallets/", "../src/onchain/", "../src/outcomes/", "../src/api/", "../src/history/", "../src/rpc/", "../src/ui/", "../src/domain/", "../server/"]) {
    const root = new URL(dir, import.meta.url);
    for (const rel of readdirSync(root, { recursive: true }) as string[]) {
      if (!/\.(ts|tsx)$/.test(rel)) continue;
      assert.doesNotMatch(readFileSync(new URL(rel, root), "utf8"), forbidden, `${dir}${rel}`);
    }
  }
});

test("DETECTIVE performs no write RPC and no trade: no send/sign/simulate in its sources", () => {
  const root = new URL("../src/detective/", import.meta.url);
  for (const f of readdirSync(root, { recursive: true }).map(String).filter((x) => x.endsWith(".ts"))) assert.doesNotMatch(readFileSync(new URL(f, root), "utf8"), /sendTransaction|signTransaction|simulateTransaction|requestAirdrop|(?<!\w)swap\((?!s\))|\.sign\(/, f);
});

test("CLI: usage message without a mint, no network needed", () => {
  const out = execFileSync("node", ["--experimental-strip-types", "--no-warnings", "scripts/detective.ts", "--help"], { cwd: new URL("..", import.meta.url), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.match(out, /usage: npm run detective -- <MINT>/);
});
