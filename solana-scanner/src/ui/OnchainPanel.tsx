import type { OnchainAnalysis } from "../onchain/analyze.ts";
import { ONCHAIN_DISCLAIMER } from "../onchain/config.ts";
import type { OnchainResult } from "../onchain/service.ts";
import { shortAddress } from "./format.ts";

export type OnchainState =
  | { status: "loading" }
  | { status: "done"; result: OnchainResult }
  | { status: "error"; error: string };

const pct = (n: number | null | undefined) => (n === null || n === undefined ? "UNKNOWN" : `${n.toFixed(2)} %`);

export function OnchainBadge({ state, candidate }: { state: OnchainState | undefined; candidate: boolean }) {
  if (!state) return <span className="muted" title={candidate ? "Candidat : analyse en attente" : "Non analysé (cliquez sur la ligne)"}>{candidate ? "…" : "—"}</span>;
  if (state.status === "loading") return <span className="muted">analyse…</span>;
  if (state.status === "error") return <span className="warn-text" title={state.error}>erreur</span>;
  const a = state.result.analysis;
  return (
    <span className="onchain-cell" title={`On-chain Risk ${a.risk}/100 · Confidence ${a.confidence}`}>
      <strong className={`score risk-${a.risk >= 50 ? "high" : a.risk >= 25 ? "mid" : "low"}`}>{a.risk}</strong>
      <span className={`badge conf-${a.confidence.toLowerCase()}`}>{a.confidence}</span>
    </span>
  );
}

function Authority({ label, state, address }: { label: string; state: OnchainAnalysis["mintAuthority"]; address: string | null }) {
  const cls = state === "ACTIVE" ? "down" : state === "DISABLED" ? "up" : "warn-text";
  return (
    <div>
      <span className="muted">{label}</span>
      <strong className={cls}>{state}</strong>
      {address && <code className="small-text">{address}</code>}
    </div>
  );
}

export function OnchainPanel({ state, onAnalyze }: { state: OnchainState | undefined; onAnalyze: () => void }) {
  return (
    <section className="onchain">
      <h3>ON-CHAIN ANALYSIS</h3>
      {!state && (
        <p>
          <button className="secondary" onClick={onAnalyze}>
            Lancer l'analyse on-chain
          </button>{" "}
          <span className="muted small-text">Lecture seule via le RPC Solana public. Seuls les meilleurs candidats sont analysés automatiquement.</span>
        </p>
      )}
      {state?.status === "loading" && <p className="muted">Analyse on-chain en cours (RPC Solana public, requêtes limitées)…</p>}
      {state?.status === "error" && (
        <p className="warn-text">
          Analyse on-chain impossible : {state.error}{" "}
          <button className="secondary" onClick={onAnalyze}>
            Réessayer
          </button>
        </p>
      )}
      {state?.status === "done" && <OnchainDetails result={state.result} onRefresh={onAnalyze} />}
    </section>
  );
}

function OnchainDetails({ result, onRefresh }: { result: OnchainResult; onRefresh: () => void }) {
  const a = result.analysis;
  const h = a.holders;
  const related = a.related;
  return (
    <>
      <div className="detail-scores">
        <div>
          <span className="muted">On-chain Risk</span>
          <strong className={`big risk-${a.risk >= 50 ? "high" : a.risk >= 25 ? "mid" : "low"}`}>{a.risk}/100</strong>
          <span className="muted small-text">indépendant du Risk DEX Screener</span>
        </div>
        <div>
          <span className="muted">On-chain Confidence</span>
          <span className={`badge conf-${a.confidence.toLowerCase()}`}>{a.confidence}</span>
          <span className="muted small-text">{a.confidencePoints}/100 des données vérifiées</span>
        </div>
      </div>

      <div className="detail-scores">
        <Authority label="Mint authority" state={a.mintAuthority} address={a.mintAuthorityAddress} />
        <Authority label="Freeze authority" state={a.freezeAuthority} address={a.freezeAuthorityAddress} />
      </div>

      <h4>Holder concentration</h4>
      {!h ? (
        <p className="warn-text">UNKNOWN — distribution non récupérée.</p>
      ) : (
        <>
          <table className="small breakdown">
            <thead>
              <tr>
                <th />
                <th className="num">Top 1</th>
                <th className="num">Top 5</th>
                <th className="num">Top 10</th>
                <th className="num">Top 20</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>RAW (% de l'offre totale)</td>
                <td className="num">{pct(h.raw.top1)}</td>
                <td className="num">{pct(h.raw.top5)}</td>
                <td className="num">{pct(h.raw.top10)}</td>
                <td className="num">{pct(h.raw.top20)}</td>
              </tr>
              <tr>
                <td>ADJUSTED (hors comptes techniques vérifiés)</td>
                {h.adjusted ? (
                  <>
                    <td className="num">{pct(h.adjusted.top1)}</td>
                    <td className="num">{pct(h.adjusted.top5)}</td>
                    <td className="num">{pct(h.adjusted.top10)}</td>
                    <td className="num">{pct(h.adjusted.top20)}</td>
                  </>
                ) : (
                  <td colSpan={4} className="warn-text">
                    ajustement impossible (comptes non classés)
                  </td>
                )}
              </tr>
            </tbody>
          </table>
          <p className="muted small-text">
            {h.holderCount.toLocaleString("en-US")} holders avec un solde non nul ({h.tokenAccounts.toLocaleString("en-US")} comptes de token).{" "}
            {h.excluded.length
              ? `Exclus de l'ajusté : ${h.excluded.map((e) => `${e.class.label} ${pct(e.pctOfSupply)}`).join(", ")}.`
              : "Aucun compte technique vérifiable parmi les plus gros : ajusté = brut."}
          </p>
          <details>
            <summary>Plus gros comptes ({h.top.length})</summary>
            <table className="small breakdown">
              <tbody>
                {h.top.slice(0, 20).map((t) => (
                  <tr key={t.owner} className={t.class.excluded ? "excluded-row" : undefined}>
                    <td>
                      <code title={t.owner}>{shortAddress(t.owner)}</code>
                    </td>
                    <td>
                      {t.class.label}
                      <div className="muted small-text">{t.class.evidence}</div>
                    </td>
                    <td className="num">{pct(t.pctOfSupply)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}

      <h4>Creator / deployment wallet</h4>
      <p className={a.creator ? undefined : "warn-text"}>{a.creatorNote}</p>
      {result.data.creatorActivity.status === "ok" && (
        <p className="muted small-text">
          Solde : {result.data.creatorActivity.value.solBalance.toFixed(3)} SOL · tokens détenus : {pct(result.data.creatorActivity.value.tokenPct)} ·{" "}
          {result.data.creatorActivity.value.analyzedTransactions} transactions récentes analysées
        </p>
      )}

      <h4>Potentially related wallets</h4>
      {!related ? (
        <p className="warn-text">UNKNOWN — relations non analysées.</p>
      ) : related.groups.length === 0 ? (
        <p className="muted">
          Aucun lien détecté entre les {related.analyzed} plus gros wallets non techniques ({related.withKnownFunding} dont le financement initial est
          connu).
        </p>
      ) : (
        <ul className="signals anomalies">
          {related.groups.map((g, i) => (
            <li key={i}>
              <strong>
                {g.members.map((m) => shortAddress(m.address)).join(", ")} — {pct(g.share * (h?.adjustFactor ?? 1))}
              </strong>
              <div className="muted small-text">{g.reasons.join(" ; ")}</div>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small-text">Heuristiques uniquement : des wallets « potentially related » ne sont pas prouvés appartenir au même propriétaire.</p>

      <h4>RED FLAGS</h4>
      <List items={a.redFlags} cls="neg" empty="Aucun red flag détecté parmi les vérifications effectuées." />
      <h4>POSITIVE STRUCTURAL SIGNALS</h4>
      <List items={a.positives} cls="pos" empty="Aucun signal structurel positif vérifié." />
      <h4>UNKNOWN / NOT VERIFIED</h4>
      <List items={a.unknowns} cls="anomalies" empty="Toutes les vérifications prévues ont abouti." />

      <details>
        <summary>On-chain Risk : {a.risk}/100, points par catégorie</summary>
        <table className="small breakdown">
          <tbody>
            {a.categories.map((c) => (
              <CategoryRows key={c.key} c={c} />
            ))}
            <tr className="total">
              <td>Total</td>
              <td />
              <td className="num">
                <strong>{a.risk}</strong> / 100
              </td>
            </tr>
          </tbody>
        </table>
      </details>

      <p className="muted small-text">
        Données on-chain lues à {new Date(a.fetchedAt).toLocaleTimeString()} via {result.data.rpcUrl}.{" "}
        <button className="secondary" onClick={onRefresh}>
          Relancer
        </button>
      </p>
      <p className="disclaimer">{ONCHAIN_DISCLAIMER}</p>
    </>
  );
}

function CategoryRows({ c }: { c: OnchainAnalysis["categories"][number] }) {
  return (
    <>
      <tr className="cat">
        <td>
          <strong>{c.label}</strong>
        </td>
        <td />
        <td className="num">
          <strong>
            {c.points} / {c.max}
          </strong>
        </td>
      </tr>
      {c.items.map((i, k) => (
        <tr key={k} className="item">
          <td>{i.label}</td>
          <td className="muted">{i.detail}</td>
          <td className="num">+{i.points}</td>
        </tr>
      ))}
    </>
  );
}

function List({ items, cls, empty }: { items: string[]; cls: string; empty: string }) {
  if (!items.length) return <p className="muted">{empty}</p>;
  return (
    <ul className={`signals ${cls}`}>
      {items.map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  );
}
