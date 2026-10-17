import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../src/smart-money/cli/main.ts";
import { loadLocalData } from "../../src/smart-money/diagnose/load.ts";
import { explainRent } from "../../src/smart-money/diagnose/rent.ts";
import { assertNoSecrets, diagnoseWallet } from "../../src/smart-money/diagnose/run.ts";
import { addr, TOKEN_ACCOUNT_RENT_LAMPORTS, ATA_PROGRAM, DEX_PROGRAM, tx } from "../../src/smart-money/demo/fixtures.ts";
import { detectRent } from "../../src/smart-money/ledger/rent.ts";
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
  assert.equal(w.newest?.date, new Date(T0 + 105 * H).toISOString());
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

test("6-7 rent: each uncertain transaction gets a cause, evidence and a verdict; micro-trade false positives are told apart", async () => {
  const { report } = await run();
  const rent = report.rent;
  assert.equal(rent.uncertainTxs, 4);
  assert.equal(rent.identifiedTxs, 2); // the control create + close
  const by = Object.fromEntries(rent.cases.map((c) => [c.signature, c]));

  const micro = by["rent-micro"];
  assert.equal(micro.verdict, "likely_false_positive_counterparty");
  assert.equal(micro.microTrade, true);
  assert.deepEqual(micro.causes, ["non_standard_rent_like_with_ata"]);
  assert.ok(micro.accounts.some((a) => a.role === "rent_like_band" && a.isTokenOwner), "the pool is shown as a token owner");
  assert.ok(micro.notes.some((n) => /micro-achat/.test(n)), "the micro buy that became a transfer is called out");

  const t2022 = by["rent-2022"];
  assert.equal(t2022.verdict, "likely_real_account_event");
  assert.equal(t2022.microTrade, false);

  const co = by["rent-cosigned"];
  assert.deepEqual(co.causes, ["co_signer"]);
  assert.equal(co.verdict, "funding_unattributed");
  assert.equal(co.signerCount, 2);
  assert.deepEqual(co.coSigners, [{ account: addr(250), netLamports: 0 }]);
  assert.equal(co.standardCreated, 1);
  assert.ok(co.notes.some((n) => /clé temporaire/.test(n)));

  const sp = by["rent-sponsored"];
  assert.ok(sp.causes.includes("sponsored_fee_payer") && sp.causes.includes("co_signer"));
  assert.equal(sp.feePayerIsWallet, false);
  assert.ok(sp.notes.some((n) => /frais payés par un autre compte/.test(n)));

  assert.equal(by["rent-control"], undefined);
  assert.deepEqual(rent.byVerdict, { likely_false_positive_counterparty: 1, likely_real_account_event: 1, funding_unattributed: 2 });
  assert.equal(rent.microTradeCases, 1);
});

test("explainRent names the branch but never disagrees with the accounting rule (detectRent)", () => {
  const variants: ReturnType<typeof tx>[] = [];
  for (const signers of [[W], [W, addr(250)], [addr(252), W]]) for (const feePayer of [W, addr(252)]) for (const complete of [true, false]) for (const created of [0, 1]) for (const closed of [0, 1]) for (const band of [0, 2_500_000, 2_157_600]) for (const ata of [true, false]) {
    const extra: Record<string, number> = {};
    if (created) extra[addr(210)] = TOKEN_ACCOUNT_RENT_LAMPORTS;
    if (closed) extra[addr(211)] = -TOKEN_ACCOUNT_RENT_LAMPORTS;
    if (band) extra[addr(212)] = band;
    variants.push({ ...tx({ sig: "v", time: T0, wallet: W, sol: -1, tokens: { [MINTS.P]: { ui: 1 } }, programs: ata ? [DEX_PROGRAM, ATA_PROGRAM] : [DEX_PROGRAM], extraLamports: extra }), signers, feePayer, signersComplete: complete });
  }
  assert.equal(variants.length, 3 * 2 * 2 * 2 * 2 * 3 * 2);
  for (const v of variants) {
    const a = explainRent(v, W);
    const b = detectRent(v, W);
    assert.equal(a.status, b.status);
    assert.equal(a.status === "uncertain", a.causes.length > 0, "an uncertain status always has a named cause");
  }
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
  assert.match(t, /FAUX POSITIF probable/);
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
