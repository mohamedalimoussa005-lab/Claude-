import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../src/smart-money/cli/main.ts";
import { loadLocalData } from "../../src/smart-money/diagnose/load.ts";
import { assertNoSecrets, diagnoseWallet } from "../../src/smart-money/diagnose/run.ts";
import { addr, tx } from "../../src/smart-money/demo/fixtures.ts";
import { DEFAULT_THRESHOLDS } from "../../src/smart-money/config.ts";
import { MINTS, T0, H, W, writeFixture } from "./diagnoseFixture.ts";
import { tmpDir } from "./helpers.ts";

const NOW = T0 + 300 * H;
const run = async (o: Parameters<typeof writeFixture>[1] = {}) => {
  const dir = tmpDir();
  await writeFixture(dir, o);
  return { dir, report: diagnoseWallet(W, loadLocalData(dir), { now: NOW }) };
};

/** Every file under dir with its content hash and mtime. */
function snapshotDir(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(`${p}|${createHash("sha256").update(readFileSync(p)).digest("hex")}|${statSync(p).mtimeMs}`);
    }
  };
  walk(dir);
  return out;
}

test("read-only: running the diagnostic changes no file and creates none", async () => {
  const dir = tmpDir();
  await writeFixture(dir);
  const before = snapshotDir(dir);
  await new Promise((r) => setTimeout(r, 20));
  const out: string[] = [];
  const code = await main(["diagnose"], { SMART_MONEY_DIR: dir }, (s) => out.push(s));
  await main(["diagnose", "--json"], { SMART_MONEY_DIR: dir }, () => undefined);
  assert.equal(code, 0);
  assert.deepEqual(snapshotDir(dir), before);
  assert.ok(!existsSync(join(dir, "observations.lock")));
});

test("the diagnose modules have no way to write, lock or reach the network", () => {
  const root = new URL("../../src/smart-money/diagnose/", import.meta.url);
  for (const f of readdirSync(root)) {
    const src = readFileSync(new URL(f, root), "utf8");
    assert.ok(!/writeFileSync|appendFileSync|renameSync|mkdirSync|rmSync|unlinkSync|copyFileSync|withLock|SmartMoneyStore|atomicWrite|fetch\(|node:http/.test(src), `diagnose/${f}`);
  }
});

test("1-2 window: exact dates, and what is absent is said", async () => {
  const { report } = await run();
  const w = report.window;
  assert.equal(w.oldest?.date, new Date(T0 + 1 * H).toISOString());
  assert.equal(w.newest?.date, new Date(T0 + 107 * H).toISOString());
  assert.equal(w.matchesReport, true);
  assert.ok(w.absent.some((a) => /AUCUNE donnée/.test(a) && a.includes(w.oldest!.date!)));
  assert.ok(w.absent.some((a) => /première transaction.*INCONNUE/.test(a)));
  assert.ok(w.spanDays! > 4 && w.txPerDay! > 0);
});

test("without a saved report the completeness is unknown and said so", async () => {
  const { report } = await run({ report: false });
  assert.equal(report.window.status, "partial");
  assert.ok(report.window.absent.some((a) => /Pas de rapport enregistré/.test(a)));
  assert.equal(report.reconciliation.status, "impossible");
  assert.ok(report.impossible.some((i) => i.section === "complétude de la collecte"));
});

test("3 reconciliation: listed = retrieved + failed + missing, and the budget proves the failed ones were never requested", async () => {
  const { report } = await run();
  const c = report.reconciliation;
  assert.equal(c.status, "ok");
  assert.equal(c.gap, 5);
  assert.equal(c.gapExplained, true);
  assert.equal(c.budget?.verdict, "failed_not_requested");
  assert.match(c.verdict, /Réconcilié/);
  assert.match(c.verdict, /jamais été demandées/);
});

test("reconciliation: other budgets, an unexplained gap, server-side filtering and a failed tx in the cache are all reported", async () => {
  const requested = await run({ patch: (r) => { r.budget!.calls += 5; } });
  assert.equal(requested.report.reconciliation.budget?.verdict, "failed_requested");
  assert.match(requested.report.reconciliation.verdict, /réellement demandées/);
  const odd = await run({ patch: (r) => { r.budget!.calls += 2; } });
  assert.equal(odd.report.reconciliation.budget?.verdict, "unexplained");
  const gap = await run({ patch: (r) => { r.history.failedSkipped = 3; } });
  assert.equal(gap.report.reconciliation.gapExplained, false);
  assert.match(gap.report.reconciliation.verdict, /ÉCART NON EXPLIQUÉ/);
  const filtered = await run({ patch: (r) => { r.history.failedSkipped = null; } });
  assert.equal(filtered.report.reconciliation.status, "partial");
  const bad = await run({ extraCacheTxs: [{ ...tx({ sig: "failed-in-cache", time: T0 + 3 * H, wallet: W, sol: -0.00001, failed: true }) }] });
  assert.equal(bad.report.reconciliation.failedInCache, 1);
  assert.match(bad.report.reconciliation.verdict, /ALERTE/);
});

test("4 sales without a known buy are grouped by token with signature, slot and date", async () => {
  const { report } = await run();
  const o = report.orphans;
  assert.equal(o.salesWithoutKnownBuy, 5); // P×3, Q, R
  assert.equal(o.distinctTokens, 3);
  const g = Object.fromEntries(o.groups.map((x) => [x.mint, x]));
  assert.equal(g[MINTS.P].sales.length, 3);
  assert.deepEqual(g[MINTS.P].sales.map((s) => s.signature), ["p1", "p2", "p3"]);
  assert.equal(g[MINTS.P].category, "pre_window");
  assert.equal(g[MINTS.Q].category, "pre_window");
  assert.equal(g[MINTS.P].sales[0].date, new Date(T0 + 1 * H).toISOString());
  assert.equal(typeof g[MINTS.P].sales[0].slot, "number");
  assert.equal(g[MINTS.P].sales[2].hoursAfterWindowStart, 29);
  assert.equal(g[MINTS.P].totalOrphanAmount, 250);
  assert.equal(o.engineCrossCheck.agree, true);
});

test("5 same token, same slot: the ordering ambiguity that fabricates an orphan sale is identified; a harmless pair is not", async () => {
  const { report } = await run();
  const r = report.orphans.groups.find((x) => x.mint === MINTS.R)!;
  assert.equal(r.category, "order_ambiguity");
  assert.deepEqual(r.sales[0].sameSlotAcquisitionsAfter, ["z-buy-R"]);
  const cases = Object.fromEntries(report.orphans.sameSlot.map((c) => [c.mint, c]));
  assert.equal(cases[MINTS.R].effect, "creates_orphan_sale");
  assert.deepEqual(cases[MINTS.R].sequence.map((s) => s.signature), ["a-sell-R", "z-buy-R"]);
  assert.equal(cases[MINTS.S].effect, "none");
  assert.ok(report.impossible.some((i) => i.section === "ordre dans un slot"));
});

test("6-7 rent: only the cases engine v2 cannot prove remain; each gets a cause, the roles of the accounts and a verdict", async () => {
  const { report } = await run();
  const rent = report.rent;
  assert.equal(rent.uncertainTxs, 3);
  assert.equal(rent.identifiedTxs, 4); // Token-2022-sized creation, co-signed creation, control create + close
  const by = Object.fromEntries(rent.cases.map((c) => [c.signature, c]));
  // The old false positives are gone: the micro buy and the co-signed / Token-2022 creations are no longer uncertain.
  for (const sig of ["rent-micro", "rent-2022", "rent-cosigned", "rent-control", "rent-control-s"]) assert.equal(by[sig], undefined, sig);

  const sp = by["rent-sponsored"];
  assert.deepEqual(sp.causes, ["funder_ambiguous"]);
  assert.equal(sp.verdict, "wallet_deposit_unproven");
  assert.equal(sp.funder, "unknown");
  assert.equal(sp.swapProof, "counterparty_payment");
  assert.ok(sp.thirdParties.some((t) => t.account === addr(252) && t.role === "co_signer" && t.netLamports === -2_039_280));
  assert.equal(sp.pools.length, 1, "the pool is a counterparty, never a rent");
  assert.ok(sp.accounts.some((a) => a.role === "pool"));
  assert.ok(sp.accounts.some((a) => a.role === "wallet_ata_created"));

  const inc = by["rent-incomplete"];
  assert.deepEqual(inc.causes, ["incomplete_signers"]);
  assert.equal(inc.verdict, "signers_unavailable");
  assert.equal(inc.signersComplete, false);

  const foreign = by["rent-foreign"];
  assert.deepEqual(foreign.causes, ["standard_size_account_not_wallet_ata"]);
  assert.equal(foreign.verdict, "unrecognised_standard_size_account");
  assert.ok(foreign.accounts.some((a) => a.role === "standard_size_not_wallet_ata"));

  assert.deepEqual(rent.byVerdict, { wallet_deposit_unproven: 1, signers_unavailable: 1, unrecognised_standard_size_account: 1 });
  assert.deepEqual(rent.byCause, { funder_ambiguous: 1, incomplete_signers: 1, standard_size_account_not_wallet_ata: 1 });
});

test("8 depth: orphan tokens are ranked by how likely a modest extension reaches their purchase; the guess is labelled a heuristic", async () => {
  const { report } = await run();
  const d = report.depth;
  assert.equal(d.status, "ok");
  assert.ok(d.holdSamples >= 5);
  assert.equal(d.perGroup.length, 3);
  const by = Object.fromEntries(d.perGroup.map((g) => [g.mint, g]));
  assert.equal(by[MINTS.R].verdict, "bought_inside_window_expected"); // an ordering artefact, not a depth problem
  assert.ok(by[MINTS.P].extraHoursNeeded !== null);
  assert.equal(d.extension.of, 3);
  assert.ok(d.extension.extraHours === null || d.extension.extraHours > 0);
  assert.ok(d.caveats.some((c) => /heuristique/i.test(c)));
});

test("depth is declared impossible when there are too few closed positions to learn a holding time", async () => {
  const dir = tmpDir();
  await writeFixture(dir);
  const local = loadLocalData(dir);
  // Keep only the orphan sales: no closed position inside the window.
  const only = new Set(["p1", "p2", "p3", "q1"]);
  const snap = local.cache.snapshot!;
  const trimmed = { ...local, cache: { ...local.cache, snapshot: { ...snap, txs: snap.txs.filter((t) => only.has(t.signature)), wallets: { [W]: [...only] } }, bySignature: new Map(snap.txs.filter((t) => only.has(t.signature)).map((t) => [t.signature, t])) } };
  const r = diagnoseWallet(W, trimmed, { now: NOW });
  assert.equal(r.depth.status, "impossible");
  assert.match(r.depth.reason!, /insuffisant/);
  assert.ok(r.impossible.some((i) => i.section === "profondeur"));
});

test("10 no data at all: a clear message, no crash, no network", async () => {
  const out: string[] = [];
  const code = await main(["diagnose"], { SMART_MONEY_DIR: tmpDir() }, (s) => out.push(s));
  assert.equal(code, 2);
  assert.match(out.join("\n"), /Aucune donnée locale/);
  const dir = tmpDir();
  writeFileSync(join(dir, "x"), "");
  const broken = tmpDir();
  await writeFixture(broken);
  writeFileSync(join(broken, "cache", "history.json"), "{ broken");
  const out2: string[] = [];
  await main(["diagnose", "--wallet", W], { SMART_MONEY_DIR: broken }, (s) => out2.push(s));
  assert.match(out2.join("\n"), /illisible ou corrompu/);
  assert.match(out2.join("\n"), /IMPOSSIBLE/);
});

test("9 terminal report and JSON export; no secret, whatever the environment holds", async () => {
  const dir = tmpDir();
  await writeFixture(dir);
  const env = { SMART_MONEY_DIR: dir, HELIUS_API_KEY: "abcd1234-ef56-7890-abcd-ef1234567890" };
  const text: string[] = [];
  assert.equal(await main(["diagnose"], env, (s) => text.push(s)), 0);
  const t = text.join("\n");
  for (const h of ["1. FENÊTRE", "2. RÉCONCILIATION", "3. VENTES SANS ACHAT", "4. MÊME TOKEN, MÊME SLOT", "5. RENT NON ATTRIBUABLE", "6. QUELLES POSITIONS", "DIAGNOSTICS IMPOSSIBLES", "lecture seule"]) assert.ok(t.includes(h), h);
  assert.match(t, /AMBIGUÏTÉ D'ORDRE/);
  assert.match(t, /dépôt du wallet non prouvé/);
  assert.equal(t.includes(env.HELIUS_API_KEY), false);

  const json: string[] = [];
  await main(["diagnose", "--json"], env, (s) => json.push(s));
  const parsed = JSON.parse(json.join("\n"));
  assert.equal(parsed.schema, "smart-money.diagnose/1");
  assert.equal(parsed.readOnly, true);
  assert.equal(parsed.network, false);
  assert.equal(JSON.stringify(parsed).includes(env.HELIUS_API_KEY), false);
  assert.equal(JSON.stringify(parsed).includes("bigint"), false);
});

test("--out writes the JSON only outside the data directory and never over an existing file by accident", async () => {
  const dir = tmpDir();
  await writeFixture(dir);
  const outDir = tmpDir();
  const target = join(outDir, "diag.json");
  const env = { SMART_MONEY_DIR: dir };
  assert.equal(await main(["diagnose", "--out", target], env, () => undefined), 0);
  assert.equal(JSON.parse(readFileSync(target, "utf8")).wallet, W);
  const out: string[] = [];
  assert.equal(await main(["diagnose", "--out", target], env, (s) => out.push(s)), 2);
  assert.match(out.join("\n"), /--overwrite/);
  assert.equal(await main(["diagnose", "--out", target, "--overwrite"], env, () => undefined), 0);
  const inside: string[] = [];
  assert.equal(await main(["diagnose", "--out", join(dir, "snapshots", "x.json")], env, (s) => inside.push(s)), 2);
  assert.match(inside.join("\n"), /dossier de données/);
});

test("the secret guard refuses key-shaped content", () => {
  assert.throws(() => assertNoSecrets("x?api-key=abc", {}), /api-key/);
  assert.throws(() => assertNoSecrets("id 123e4567-e89b-12d3-a456-426614174000", {}), /key-shaped/);
  assert.throws(() => assertNoSecrets("leak supersecretvalue", { HELIUS_API_KEY: "supersecretvalue" }), /environment/);
  assert.doesNotThrow(() => assertNoSecrets("signature 5abc and wallet 11111111111111111111111111111111", { HELIUS_API_KEY: "" }));
});

test("the default thresholds are the ones the accounting uses", () => {
  assert.equal(DEFAULT_THRESHOLDS.solNoiseSol, 0.005);
});
