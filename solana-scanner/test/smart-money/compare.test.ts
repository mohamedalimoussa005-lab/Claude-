import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../src/smart-money/cli/main.ts";
import { compareWallet } from "../../src/smart-money/compare/compare.ts";
import { loadLocalData } from "../../src/smart-money/diagnose/load.ts";
import { heatLikeTxs, H, MINT, SUSPECT_SLOT, T0, W } from "./heatFixture.ts";
import { writeFixture } from "./diagnoseFixture.ts";
import { tmpDir } from "./helpers.ts";

const setup = async (o: Parameters<typeof writeFixture>[1] = {}) => {
  const dir = tmpDir();
  await writeFixture(dir, { txs: heatLikeTxs(), ...o });
  return { dir, c: compareWallet(W, loadLocalData(dir), { now: T0 + 300 * H }) };
};

function snap(dir: string): string[] {
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

test("compare: the suspect transaction is listed with its signature, slot, before / after and the reason", async () => {
  const { c } = await setup();
  const r = c.reclassified.find((x) => x.signature === "suspect-micro")!;
  assert.equal(r.slot, SUSPECT_SLOT);
  assert.deepEqual(r.changes.sort(), ["class", "rent"]);
  assert.match(r.before, /transfert entrant \(no_quote_leg\)/);
  assert.match(r.after, /achat 0\.00165\d* SOL/);
  assert.ok(r.explanation.some((e) => /plage numérique 890 880–3 000 000/.test(e)), "v1 cause explained");
  assert.ok(r.explanation.some((e) => /swap prouvé par la contrepartie/.test(e)), "v2 proof explained");
  assert.ok(r.explanation.some((e) => /petit montant conservé comme trade/.test(e)));
});

test("compare: every reclassification names what changed and why; signatures are kept", async () => {
  const { c } = await setup();
  const by = Object.fromEntries(c.reclassified.map((r) => [r.signature, r]));
  assert.ok(by["pool-in-band"] && by["t22-create"] && by["temp-cosigner"] && by["micro-sell"]);
  assert.ok(by["t22-create"].explanation.some((e) => /loyer prouvé/.test(e)));
  assert.ok(by["temp-cosigner"].changes.includes("rent"));
  assert.equal(by["sponsored"], undefined, "an unprovable case is uncertain in both engines: not reclassified");
  for (const r of c.reclassified) {
    assert.ok(r.signature.length > 0 && r.explanation.length > 0 && r.changes.length > 0);
  }
  // amounts: with the rent proven, the cost no longer contains it
  assert.ok(by["t22-create"].changes.includes("amount"));
});

test("compare: rent-uncertain transactions drop, and the remaining ones are named", async () => {
  const { c } = await setup();
  assert.ok(c.rent.v2Uncertain < c.rent.v1Uncertain, `${c.rent.v1Uncertain} → ${c.rent.v2Uncertain}`);
  assert.equal(c.rent.v2Uncertain, 1); // the sponsored case
  assert.deepEqual(c.rent.v2ByReason, { funder_ambiguous: 1 });
  assert.equal(c.rent.newlyUncertain, 0);
  assert.ok(c.rent.resolved >= 4);
  assert.ok(c.counts.v2.transfersIn < c.counts.v1.transfersIn, "micro buys are no longer transfers");
  assert.ok(c.counts.v2.buys > c.counts.v1.buys);
});

test("compare: profits are declared unreliable when the history is truncated or its completeness unknown", async () => {
  const noReport = await setup({ report: false });
  assert.equal(noReport.c.reliability.profitsReliable, false);
  assert.equal(noReport.c.reliability.knownFromReport, false);
  assert.match(noReport.c.reliability.message, /PnL NON FIABLE/);
  const truncated = await setup();
  assert.equal(truncated.c.reliability.historyComplete, false);
  assert.equal(truncated.c.positions.v2.KNOWN, 0);
  assert.match(truncated.c.pnl.note, /PAS un profit/);
  const complete = await setup({ patch: (r) => { r.history.complete = true; r.history.stopReason = "end_of_history"; } });
  assert.equal(complete.c.reliability.profitsReliable, true);
  assert.ok(complete.c.positions.v2.KNOWN >= 1);
});

test("compare: the derivation is checked against the data itself, and a failure is loud", async () => {
  const { c } = await setup();
  assert.equal(c.derivationCheck.confirmed, true);
  assert.ok(c.derivationCheck.walletAtaAccountsFound >= 3);
  assert.match(c.derivationCheck.verdict, /confirmée/);
  // Same data, but the wallet's accounts are not the derived ones: the check must say it is NOT confirmed.
  const dir = tmpDir();
  const txs = heatLikeTxs().map((t) => ({ ...t, lamportDeltas: Object.fromEntries(Object.entries(t.lamportDeltas).map(([k, v]) => [Math.abs(v) === 2_039_280 || v === 2_157_600 ? `X${k.slice(1)}` : k, v])) }));
  await writeFixture(dir, { txs });
  const off = compareWallet(W, loadLocalData(dir), { now: T0 });
  assert.equal(off.derivationCheck.confirmed, false);
  assert.match(off.derivationCheck.verdict, /NON CONFIRMÉE/);
});

test("compare: positions and orphan sales are compared, with the tokens whose positions changed", async () => {
  const { c } = await setup();
  assert.equal(c.positions.orphanSalesV1, c.positions.orphanSalesV2);
  assert.ok(c.positions.v1.UNKNOWN >= 3);
  const changed = c.positions.changedTokens.map((t) => t.mint);
  assert.ok(changed.includes(MINT.micro), "the micro buy now opens a position with a KNOWN cost");
  const micro = c.positions.changedTokens.find((t) => t.mint === MINT.micro)!;
  assert.deepEqual([micro.v1, micro.v2], [["OPEN (coût inconnu)"], ["OPEN (coût connu)"]]);
});

test("compare CLI: read-only on the cache and snapshots, text and JSON, no secret, and --out stays outside the data directory", async () => {
  const dir = tmpDir();
  await writeFixture(dir, { txs: heatLikeTxs() });
  const before = snap(dir);
  await new Promise((r) => setTimeout(r, 20));
  const env = { SMART_MONEY_DIR: dir, HELIUS_API_KEY: "abcd1234-ef56-7890-abcd-ef1234567890" };
  const text: string[] = [];
  assert.equal(await main(["compare"], env, (s) => text.push(s)), 0);
  const t = text.join("\n");
  for (const h of ["COMPARAISON AVANT / APRÈS", "1. CLASSEMENT", "2. LOYER INCERTAIN", "3. TRANSACTIONS RECLASSÉES", "4. POSITIONS FERMÉES", "5. PnL INDICATIF", "6. VALIDATION DE LA DÉRIVATION", "PnL NON FIABLE", "lecture seule"]) assert.ok(t.includes(h), h);
  assert.match(t, /avant : transfert entrant/);
  assert.match(t, /après : achat/);
  assert.equal(t.includes(env.HELIUS_API_KEY), false);

  const json: string[] = [];
  assert.equal(await main(["compare", "--json"], env, (s) => json.push(s)), 0);
  const parsed = JSON.parse(json.join("\n"));
  assert.deepEqual([parsed.schema, parsed.readOnly, parsed.network], ["smart-money.compare/1", true, false]);
  assert.equal(JSON.stringify(parsed).includes(env.HELIUS_API_KEY), false);

  const outDir = tmpDir();
  const target = join(outDir, "cmp.json");
  assert.equal(await main(["compare", "--out", target], env, () => undefined), 0);
  assert.equal(JSON.parse(readFileSync(target, "utf8")).wallet, W);
  const out: string[] = [];
  assert.equal(await main(["compare", "--out", join(dir, "x.json")], env, (s) => out.push(s)), 2);
  assert.match(out.join("\n"), /dossier de données/);
  assert.equal(await main(["compare", "--out", target], env, () => undefined), 2); // exists, no --overwrite

  assert.deepEqual(snap(dir), before, "the original data is untouched");
  assert.ok(!existsSync(join(dir, "observations.lock")));
  const none: string[] = [];
  assert.equal(await main(["compare"], { SMART_MONEY_DIR: tmpDir() }, (s) => none.push(s)), 2);
  assert.match(none.join("\n"), /Aucune donnée locale/);
});

test("compare modules cannot write, lock or reach the network", () => {
  const root = new URL("../../src/smart-money/compare/", import.meta.url);
  for (const f of readdirSync(root)) assert.ok(!/writeFileSync|appendFileSync|renameSync|mkdirSync|rmSync|unlinkSync|withLock|SmartMoneyStore|atomicWrite|fetch\(|node:http/.test(readFileSync(new URL(f, root), "utf8")), f);
});
