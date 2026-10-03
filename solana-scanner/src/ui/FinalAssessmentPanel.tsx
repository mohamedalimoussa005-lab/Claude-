import { assessToken } from "../final/assessment.ts";
import type { FinalDecision, Reason } from "../final/assessment.ts";
import type { ScoredPair } from "../scoring/score.ts";
import type { OnchainState } from "./OnchainPanel.tsx";
import type { WalletState } from "./WalletPanel.tsx";

const BADGE: Record<FinalDecision, string> = { MOMENTUM: "momentum", WATCH: "watch", CAUTION: "conf-medium", AVOID: "high-risk", "NO SIGNAL": "conf-low" };

function Reasons({ title, items, cls, mark }: { title: string; items: Reason[]; cls: string; mark: string }) {
  if (!items.length) return null;
  return (
    <>
      <h5>{title}</h5>
      <ul className={`signals ${cls} small-text`}>
        {items.map((r) => (
          <li key={r.fact}>
            {mark} {r.text}
            {r.sources.length > 1 && <span className="muted"> · sources : {r.sources.join(" + ")}</span>}
          </li>
        ))}
      </ul>
    </>
  );
}

/** Final decision from the engines' existing results; computed here, never fetched. */
export function FinalAssessmentPanel({ row, onchain, wallets }: { row: ScoredPair; onchain: OnchainState | undefined; wallets: WalletState | undefined }) {
  const a = assessToken({
    score: row.score,
    onchain: onchain?.status === "done" ? onchain.result : null,
    wallets: wallets?.status === "done" ? wallets.intel : null,
  });
  const w = a.dataConfidence.wallets;
  return (
    <section className="onchain final-assessment">
      <h3>FINAL ASSESSMENT</h3>
      <p>
        Decision <span className={`badge ${BADGE[a.decision]}`}>{a.decision}</span> · Base :{" "}
        {a.baseDexLabel ? `DEX ${a.baseDexLabel}` : "aucun label DEX"}
      </p>
      <p className="small-text">
        {a.why.filter((l) => !l.startsWith("BASE:") && !l.startsWith("FINAL:")).map((l, i) => (
          <span key={i}>
            {l}
            <br />
          </span>
        ))}
        <span className="muted">
          Data Confidence : DEX {a.dataConfidence.dex} · on-chain {a.dataConfidence.onchain ?? "non analysé"} · wallets{" "}
          {w ? `HIGH ${w.HIGH} / MEDIUM ${w.MEDIUM} / LOW ${w.LOW} / UNKNOWN ${w.UNKNOWN}` : "non analysés"}
        </span>
      </p>
      <Reasons title="Positive" items={a.positives} cls="pos" mark="+" />
      <Reasons title="Negative" items={a.negatives} cls="neg" mark="−" />
      <Reasons title="Uncertainty" items={a.uncertainties} cls="anomalies" mark="?" />
      <Reasons title="Informational" items={a.informational} cls="" mark="i" />
      <p className="muted small-text">
        Décision descriptive du scanner (MOMENTUM, WATCH, CAUTION, AVOID, NO SIGNAL), fondée sur des faits observés ; ce n'est pas une recommandation d'achat
        ou de vente. Les données UNKNOWN réduisent la certitude, elles ne comptent jamais comme un signal négatif.
      </p>
    </section>
  );
}
