import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { SmartMoneyStore } from "../store/store.ts";
import { formatProfile, formatRounds } from "../pnl/format.ts";
import { profileEvent } from "../pnl/events.ts";
import { analyzeWallet } from "../pnl/profile.ts";
import { addr, demoWalletTxs } from "./fixtures.ts";

/** Runs the pipeline on FICTIONAL data and writes the event to a throw-away store. */
export async function runDemo(log: (s: string) => void, o: { dir?: string } = {}): Promise<{ dir: string }> {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "smart-money-demo-"));
  const config = loadConfig({});
  const wallet = addr(11);
  const txs = demoWalletTxs(wallet);
  log("=== DÉMONSTRATION — DONNÉES ENTIÈREMENT FICTIVES (aucun appel réseau) ===");
  for (const complete of [true, false]) {
    const { pnl, profile } = analyzeWallet(wallet, txs, { coverage: { complete, oldestTime: null }, config });
    log(`\n--- historique ${complete ? "complet" : "INCOMPLET"} ---`);
    log(formatProfile(profile));
    if (complete) {
      log("\nPositions non connues ou atypiques :");
      log(formatRounds(pnl.rounds.filter((r) => r.status !== "KNOWN" || r.quote === "USD")));
      const store = new SmartMoneyStore(dir);
      const [res] = await store.appendEvents([profileEvent(profile, pnl, { now: Date.UTC(2026, 9, 1), criteriaVersion: config.criteriaVersion, simulated: true })]);
      log(`\nÉvénement écrit (simulated=true) : seq ${res.event.seq} · ${res.event.kind} · ${res.event.eventId} · qualité ${res.event.dataQuality.level}`);
      log(`Mémoire de démonstration : ${dir}`);
    }
  }
  return { dir };
}
