import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../src/smart-money/cli/main.ts";
import { createLiveService } from "../../scripts/smart-money-live.ts";
import { SmartMoneyStore } from "../../src/smart-money/store/store.ts";
import { addr, buy, buyCreatingAta, DEMO_START, sell, sellClosingAta } from "../../src/smart-money/demo/fixtures.ts";
import type { HistoryTx } from "../../src/history/types.ts";
import { fakeNetwork, KEY } from "./fakeNetwork.ts";
import { tmpDir } from "./helpers.ts";

const W = addr(11);
const H = 3_600_000;
const FAST = { heliusPerSecond: 100_000, rpcPerWindow: 100_000 };

function history(n: number): HistoryTx[] {
  const out: HistoryTx[] = [];
  for (let i = 0; i < n / 2; i++) {
    const t = DEMO_START + i * 2 * H;
    out.push(buyCreatingAta(`b${String(i).padStart(3, "0")}`, t, W, addr(30 + i), 1000, 1, addr(160 + i)), sellClosingAta(`s${String(i).padStart(3, "0")}`, t + H, W, addr(30 + i), 1000, 2, addr(160 + i)));
  }
  return out;
}

async function cli(env: Record<string, string>, deps: Parameters<typeof main>[3], ...args: string[]) {
  const out: string[] = [];
  const code = await main(args, env, (s) => out.push(s), deps);
  return { code, out: out.join("\n") };
}

/** A fetch that fails the test if anything tries the network. */
const NO_NETWORK = { createLiveService, fetchImpl: (async () => { throw new Error("network must not be used"); }) as typeof fetch };

test("wallet --demo analyses a fictional history through the real service, with no network", async () => {
  const r = await cli({ SMART_MONEY_DIR: tmpDir() }, NO_NETWORK, "wallet", "--demo");
  assert.equal(r.code, 0);
  assert.match(r.out, /DÉMO fictive/);
  assert.match(r.out, /Transactions : \d+ listées/);
  assert.match(r.out, /Trades reconstruits/);
  assert.match(r.out, /CONNUES · \d+ PARTIELLES · \d+ PROVISOIRES · \d+ INCONNUES/);
  assert.match(r.out, /Étiquette : aucune/);
  const cut = await cli({ SMART_MONEY_DIR: tmpDir() }, NO_NETWORK, "wallet", "--demo", "--max-pages", "1");
  assert.match(cut.out, /TRONQUÉ/);
});

test("without a mode, nothing is fetched and the estimate is shown", async () => {
  const r = await cli({ SMART_MONEY_DIR: tmpDir(), HELIUS_API_KEY: KEY }, NO_NETWORK, "wallet", W);
  assert.equal(r.code, 2);
  assert.match(r.out, /rien n'est envoyé/);
  assert.match(r.out, /Estimation/);
});

test("--dry-run estimates calls and credits and sends nothing, with or without --live", async () => {
  const r = await cli({ SMART_MONEY_DIR: tmpDir(), HELIUS_API_KEY: KEY }, NO_NETWORK, "wallet", W, addr(12), "--dry-run", "--live", "--max-tx", "200");
  assert.equal(r.code, 0);
  assert.match(r.out, /crédits Helius/);
  assert.match(r.out, /Garde live : REFUSÉE/); // no budget, no acknowledgement yet
  assert.match(r.out, /--max-credits requis/);
  const est = await cli({}, NO_NETWORK, "estimate", "--wallets", "3");
  assert.match(est.out, /helius_rpc/);
});

test("--live is refused unless every condition holds; nothing is sent", async () => {
  const env = { SMART_MONEY_DIR: tmpDir(), HELIUS_API_KEY: KEY };
  const noGate = await cli(env, NO_NETWORK, "wallet", W, "--live");
  assert.equal(noGate.code, 2);
  assert.match(noGate.out, /REFUSÉ — rien n'a été envoyé/);
  assert.match(noGate.out, /SMART_MONEY_LIVE_OK/);
  const four = await cli({ ...env, SMART_MONEY_LIVE_OK: "yes" }, NO_NETWORK, "wallet", addr(1), addr(2), addr(3), addr(4), "--live", "--max-credits", "100", "--max-calls", "100", "--ack-no-autoscale");
  assert.equal(four.code, 2);
  assert.match(four.out, /3 wallets/);
  const other = await cli(env, NO_NETWORK, "run", "--live");
  assert.equal(other.code, 2);
});

test("live run end to end on a fake network: report, snapshot, event, cache, budget, and the key is never printed", async () => {
  const dir = tmpDir();
  const env = { SMART_MONEY_DIR: dir, HELIUS_API_KEY: KEY, SMART_MONEY_LIVE_OK: "yes" };
  const net = fakeNetwork({ [W]: history(60) });
  const args = ["wallet", W, "--live", "--provider", "helius-rpc", "--max-credits", "200", "--max-calls", "200", "--ack-no-autoscale", "--save", "--emit"];
  const r = await cli(env, { createLiveService, fetchImpl: net.fetchImpl, testRates: FAST }, ...args);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /source RÉELLE/);
  assert.match(r.out, /Historique : COMPLET/);
  assert.match(r.out, /30 CONNUES · 0 PARTIELLES/);
  assert.match(r.out, /Budget : 61\/200 appels · ~61\/200 crédits/);
  assert.match(r.out, /Transport : authenticated_rpc: 61 ok/);
  assert.equal(r.out.includes(KEY), false);
  assert.equal(net.count("transaction"), 60);

  const store = new SmartMoneyStore(dir);
  const events = store.readEvents().events;
  assert.equal(events.length, 1);
  assert.equal(events[0].simulated, false);
  assert.equal(events[0].dataQuality.level, "HIGH"); // complete history, 30 known positions, rent identified
  assert.equal(store.status().snapshots.some((s) => s.startsWith("wallet-")), true);
  const cachePath = join(dir, "cache", "history.json");
  assert.ok(existsSync(cachePath));
  assert.equal(readFileSync(cachePath, "utf8").includes(KEY), false);
  for (const f of [join(dir, "outbox", "events.jsonl")]) assert.equal(readFileSync(f, "utf8").includes(KEY), false);

  const again = await cli(env, { createLiveService, fetchImpl: net.fetchImpl, testRates: FAST }, ...args);
  assert.match(again.out, /Budget : 1\/200 appels/); // signature listing only: nothing downloaded twice
  assert.equal(net.count("transaction"), 60);
});

test("live run with a too-small budget returns a TRONQUÉ history and says so", async () => {
  const env = { SMART_MONEY_DIR: tmpDir(), HELIUS_API_KEY: KEY, SMART_MONEY_LIVE_OK: "yes" };
  const net = fakeNetwork({ [W]: history(60) });
  const r = await cli(env, { createLiveService, fetchImpl: net.fetchImpl, testRates: FAST }, "wallet", W, "--live", "--provider", "helius-rpc", "--max-credits", "30", "--max-calls", "30", "--ack-no-autoscale", "--max-pages", "20");
  assert.equal(r.code, 1);
  assert.match(r.out, /TRONQUÉ/);
  assert.match(r.out, /budget d'appels \/ crédits épuisé/);
  assert.match(r.out, /0 CONNUES/);
  assert.ok(net.seen.length <= 30);
});

test("offline file: complete only if declared complete", async () => {
  const dir = tmpDir();
  const file = join(dir, "h.json");
  writeFileSync(file, JSON.stringify({ txs: [buy("b", DEMO_START, W, addr(40), 10, 1), sell("s", DEMO_START + H, W, addr(40), 10, 2)] }));
  const env = { SMART_MONEY_DIR: dir };
  const unverified = await cli(env, NO_NETWORK, "wallet", W, "--offline", file);
  assert.match(unverified.out, /TRONQUÉ \/ INCOMPLET/);
  assert.match(unverified.out, /n'est pas garantie complète/);
  const declared = await cli(env, NO_NETWORK, "wallet", W, "--offline", file, "--file-complete");
  assert.match(declared.out, /Historique : COMPLET/);
  assert.match(declared.out, /1 CONNUES/);
  assert.equal((await cli(env, NO_NETWORK, "wallet", W, "--offline", join(dir, "missing.json"))).code, 2);
});

test("preflight is offline, never prints the key, and states what it cannot verify", async () => {
  const withKey = await cli({ SMART_MONEY_DIR: tmpDir(), HELIUS_API_KEY: KEY }, NO_NETWORK, "preflight");
  assert.match(withKey.out, /présente \(jamais affichée\)/);
  assert.equal(withKey.out.includes(KEY), false);
  assert.match(withKey.out, /Ce que je ne peux PAS vérifier/);
  assert.match(withKey.out, /1 000 000 crédits\/mois|1\s?000\s?000 crédits\/mois/);
  const noKey = await cli({ SMART_MONEY_DIR: tmpDir() }, NO_NETWORK, "preflight");
  assert.match(noKey.out, /ABSENTE/);
});

test("a provider that rejects us stops the whole run: the next wallet is never tried", async () => {
  const env = { SMART_MONEY_DIR: tmpDir(), HELIUS_API_KEY: KEY, SMART_MONEY_LIVE_OK: "yes" };
  const net = fakeNetwork({ [W]: history(20), [addr(12)]: history(20) }, { unauthorized: true });
  const r = await cli(env, { createLiveService, fetchImpl: net.fetchImpl, testRates: FAST }, "wallet", W, addr(12), "--live", "--provider", "helius", "--max-credits", "200", "--max-calls", "50", "--ack-no-autoscale");
  assert.equal(r.code, 1);
  assert.match(r.out, /wallets suivants ne sont pas tentés/);
  assert.match(r.out, /échecs fournisseur : auth/);
  assert.equal(net.seen.length, 1);
});

test("without the injected network factory there is no live mode at all", async () => {
  const env = { SMART_MONEY_DIR: tmpDir(), HELIUS_API_KEY: KEY, SMART_MONEY_LIVE_OK: "yes" };
  const out: string[] = [];
  const code = await main(["wallet", W, "--live", "--max-credits", "100", "--max-calls", "100", "--ack-no-autoscale", "--provider", "helius-rpc"], env, (s) => out.push(s), {});
  assert.equal(code, 2);
  assert.match(out.join("\n"), /pas disponible dans ce contexte/);
});
