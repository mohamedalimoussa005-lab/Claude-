import { useState } from "react";
import { WALLET_CONFIG, WALLET_DISCLAIMER } from "../wallets/config.ts";
import type { TrackedWallet, WalletIntel } from "../wallets/intel.ts";
import { shortAddress } from "./format.ts";

export type WalletState = { status: "loading" } | { status: "done"; intel: WalletIntel } | { status: "error"; error: string };

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "UNKNOWN" : `${x > 0 ? "+" : ""}${(x * 100).toFixed(0)} %`);
const mins = (m: number | null) => (m === null ? "UNKNOWN" : m < 60 ? `${m.toFixed(1)} min` : `${(m / 60).toFixed(1)} h`);
const ago = (t: number | null) => (t === null ? "?" : `il y a ${Math.max(0, Math.round((Date.now() - t) / 60_000))} min`);
const usd = (x: number | null) => (x === null ? "?" : `$${x >= 1000 ? `${(x / 1000).toFixed(1)}k` : x.toFixed(0)}`);

export function WalletPanel({ state, onchainReady, onAnalyze }: { state: WalletState | undefined; onchainReady: boolean; onAnalyze: () => void }) {
  return (
    <section className="onchain wallets">
      <h3>WALLET INTELLIGENCE</h3>
      {!state && (
        <p>
          <button className="secondary" onClick={onAnalyze} disabled={!onchainReady}>
            Analyser les wallets acheteurs
          </button>{" "}
          <span className="muted small-text">
            {onchainReady
              ? "≈ 2 min : le RPC Solana gratuit sert environ une transaction par seconde."
              : "Disponible après l'analyse on-chain (pipeline : on-chain d'abord, wallets ensuite)."}
          </span>
        </p>
      )}
      {state?.status === "loading" && <p className="muted">Analyse des acheteurs en cours (RPC public, ≈ 1 transaction/s)…</p>}
      {state?.status === "error" && (
        <p className="warn-text">
          Analyse impossible : {state.error}{" "}
          <button className="secondary" onClick={onAnalyze}>
            Réessayer
          </button>
        </p>
      )}
      {state?.status === "done" && <WalletIntelView intel={state.intel} />}
    </section>
  );
}

function WalletIntelView({ intel }: { intel: WalletIntel }) {
  const [open, setOpen] = useState<string | null>(null);
  const selected = intel.tracked.find((t) => t.address === open) ?? null;
  const s = intel.scan;
  return (
    <>
      <div className="detail-scores">
        <div>
          <span className="muted">Tracked wallets</span>
          <strong className="big">{intel.tracked.length}</strong>
          <span className="muted small-text">sur {intel.buyersIdentified} acheteurs identifiés</span>
        </div>
        <div>
          <span className="muted">Independent clusters</span>
          <strong className="big">{intel.independentClusters}</strong>
          <span className="muted small-text">wallets liés comptés une fois</span>
        </div>
        <div>
          <span className="muted">High-quality histories</span>
          <strong className="big">{intel.highQuality}</strong>
          <span className="muted small-text">{intel.historiesReconstructed} historique(s) reconstruit(s)</span>
        </div>
      </div>

      <p className="small-text">
        Lancement : {s.launchReachable && s.launch?.time ? new Date(s.launch.time).toLocaleTimeString() : "hors de portée (UNKNOWN)"} ·{" "}
        {s.signaturesScanned.toLocaleString("en-US")} signatures parcourues · acheteurs dans le bloc de création :{" "}
        {s.launchReachable ? intel.launchSlotBuyers : "UNKNOWN"}
        {intel.creatorBuys && (
          <>
            {" "}
            · <span className="warn-text">deployment-associated wallet : {intel.creatorBuys.tokenPct?.toFixed(1) ?? "?"} % de l'offre achetés pour {intel.creatorBuys.sol.toFixed(2)} SOL au lancement</span>
          </>
        )}
      </p>
      <p className="small-text">
        Total estimated inflow (wallets suivis, transactions échantillonnées) : <strong>{intel.trackedInflowSol.toFixed(2)} SOL</strong> ≈{" "}
        {usd(intel.trackedInflowUsdEst)} (estimé au prix SOL actuel)
      </p>

      <h4>Recent entries</h4>
      {intel.recentEntries.length === 0 ? (
        <p className="muted">Aucun achat ≥ {WALLET_CONFIG.discovery.minBuySol} SOL parmi les transactions récentes échantillonnées.</p>
      ) : (
        <ul className="signals">
          {intel.recentEntries.slice(0, 6).map((e) => (
            <li key={e.address}>
              <code>{shortAddress(e.address)}</code> — {ago(e.time)} · {e.sol.toFixed(2)} SOL
            </li>
          ))}
        </ul>
      )}

      <h4>Wallets suivis</h4>
      <div className="table-wrap inner">
        <table className="small breakdown wallet-table">
          <thead>
            <tr>
              <th>Wallet</th>
              <th>Entry</th>
              <th className="num">Estimated amount</th>
              <th className="num">Wallet Quality</th>
              <th>Confidence</th>
              <th className="num">Historical trades</th>
              <th className="num">Median return</th>
              <th className="num">Early-entry rate</th>
              <th className="num">Cluster</th>
            </tr>
          </thead>
          <tbody>
            {intel.tracked.map((t) => {
              const m = t.profile.metrics;
              return (
                <tr key={t.address} className={open === t.address ? "clickable selected" : "clickable"} onClick={() => setOpen(open === t.address ? null : t.address)}>
                  <td>
                    <code>{shortAddress(t.address)}</code>
                    {t.profile.flags.length > 0 && <span className="anomaly-count"> ⚑ {t.profile.flags.length}</span>}
                  </td>
                  <td>
                    {t.entryMinutesAfterLaunch === null ? "?" : `+${mins(t.entryMinutesAfterLaunch)}`}
                    {t.sameSlotAsLaunch && <div className="warn-text small-text">même bloc que la création</div>}
                  </td>
                  <td className="num">
                    {t.solSpent.toFixed(2)} SOL
                    <div className="muted small-text">mcap entrée {usd(t.entryMcapUsdEst)} est.</div>
                  </td>
                  <td className="num">{t.profile.quality}</td>
                  <td>
                    <span className={`badge conf-${t.profile.confidence.toLowerCase()}`}>{t.profile.confidence}</span>
                  </td>
                  <td className="num">{m ? m.evaluated : "UNKNOWN"}</td>
                  <td className="num">{m ? pct(m.medianReturn) : "UNKNOWN"}</td>
                  <td className="num">{m && m.early.known ? `${m.early.lt1h}/${m.early.known} < 1 h` : "UNKNOWN"}</td>
                  <td className="num">{t.cluster}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selected && <WalletProfileView w={selected} />}

      {intel.related.groups.length > 0 && (
        <>
          <h4>Potentially related wallets</h4>
          <ul className="signals anomalies">
            {intel.related.groups.map((g, i) => (
              <li key={i}>
                {g.members.map((m) => shortAddress(m.address)).join(", ")} — {g.reasons.join(" ; ")}
              </li>
            ))}
          </ul>
        </>
      )}
      <ul className="signals muted small-text">
        {intel.notes.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>
      <p className="disclaimer">{WALLET_DISCLAIMER}</p>
    </>
  );
}

function WalletProfileView({ w }: { w: TrackedWallet }) {
  const p = w.profile;
  const f = p.facts;
  const m = p.metrics;
  return (
    <div className="wallet-profile">
      <h4>
        WALLET PROFILE — <code>{w.address}</code>
      </h4>
      <p className="small-text">
        Wallet Quality <strong>{p.quality}/100</strong> · Confidence <span className={`badge conf-${p.confidence.toLowerCase()}`}>{p.confidence}</span> ·
        cluster {w.cluster}
      </p>

      <h5>History</h5>
      <p className="small-text">
        {f.signatureCount >= 5000 ? "≥ 5 000" : f.signatureCount} transactions · {f.historyComplete ? "historique entièrement listé" : "historique partiel"} · première activité{" "}
        {f.firstSeen ? new Date(f.firstSeen).toLocaleString() : "UNKNOWN"} · financé par {f.funder ? <code>{shortAddress(f.funder)}</code> : "UNKNOWN"}
        <br />
        {f.historyNote}
      </p>

      <h5>Performance (estimations)</h5>
      {m ? (
        <p className="small-text">
          Tokens analysés : {m.positions.length} · historique exploitable : {m.evaluated} · rentables {m.profitable}/{m.evaluated} · perdants {m.losing}/{m.evaluated}
          <br />
          Médiane {pct(m.medianReturn)} · moyenne {pct(m.averageReturn)} · meilleur {m.best ? pct(m.best.totalReturnEst) : "—"} · pire {m.worst ? pct(m.worst.totalReturnEst) : "—"}
          <br />
          PnL réalisé {m.realizedPnlSol.toFixed(3)} SOL · PnL non réalisé {m.unrealizedPnlSolEst === null ? "UNKNOWN" : `${m.unrealizedPnlSolEst.toFixed(3)} SOL (estimé)`} · multiple max après entrée :
          UNKNOWN (pas d'historique de prix)
        </p>
      ) : (
        <p className="warn-text small-text">UNKNOWN — historique non reconstruit ({f.historyNote}).</p>
      )}

      <h5>Early entries</h5>
      <p className="small-text">
        Sur ce token : {w.entryMinutesAfterLaunch === null ? "UNKNOWN" : `+${mins(w.entryMinutesAfterLaunch)} après la première transaction`}
        {w.sameSlotAsLaunch ? " (même bloc que la création)" : ""} · mcap d'entrée {usd(w.entryMcapUsdEst)} (estimée)
        {m && (
          <>
            <br />
            Historique : {m.early.known ? `< 5 min ${m.early.lt5m} · < 15 min ${m.early.lt15m} · < 1 h ${m.early.lt1h} sur ${m.early.known} tokens au lancement connu` : "lancements inconnus pour ses tokens"}
          </>
        )}
      </p>

      <h5>Hold duration</h5>
      <p className="small-text">{m ? `Médiane ${mins(m.medianHoldMinutes)} (positions entièrement vendues)` : "UNKNOWN"}</p>

      <h5>Suspicious patterns</h5>
      {p.flags.length === 0 ? (
        <p className="muted small-text">Aucun motif suspect détecté par les vérifications disponibles.</p>
      ) : (
        <ul className="signals neg small-text">
          {p.flags.map((fl) => (
            <li key={fl.key}>
              <strong>{fl.label}</strong> ({fl.severity}) — {fl.detail}
            </li>
          ))}
        </ul>
      )}

      <h5>Data completeness</h5>
      <table className="small breakdown">
        <tbody>
          {p.qualityItems.map((it, i) => (
            <tr key={i} className="item">
              <td>{it.label}</td>
              <td className="muted">{it.detail}</td>
              <td className="num">
                {it.points}
                {it.max ? ` / ${it.max}` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="signals anomalies small-text">
        {p.unknowns.map((u, i) => (
          <li key={i}>{u}</li>
        ))}
      </ul>
    </div>
  );
}
