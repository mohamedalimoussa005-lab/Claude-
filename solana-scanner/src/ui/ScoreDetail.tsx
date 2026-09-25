import { useEffect } from "react";
import { LABEL_DISCLAIMER } from "../scoring/config.ts";
import { CATEGORY_ORDER } from "../scoring/score.ts";
import type { CategoryScore, ScoredPair } from "../scoring/score.ts";
import { LabelBadge } from "./LabelBadge.tsx";
import { shortAddress } from "./format.ts";

const pts = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export function ScoreDetail({ row, fetchedAt, onClose }: { row: ScoredPair; fetchedAt: number; onClose: () => void }) {
  const { pair: p, score: s } = row;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const name = p.tokenSymbol ?? shortAddress(p.tokenAddress);

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="detail" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`Détail du score ${name}`}>
        <button className="close" onClick={onClose} aria-label="Fermer">
          ×
        </button>
        <h2>
          Pourquoi {name} a obtenu {s.opportunity}/100 ?
        </h2>
        <p className="muted">
          {p.tokenName ?? "—"} · <code>{p.tokenAddress}</code>
          {p.url && (
            <>
              {" "}
              ·{" "}
              <a href={p.url} target="_blank" rel="noreferrer">
                DEX Screener
              </a>
            </>
          )}
        </p>

        <div className="detail-scores">
          <div>
            <span className="muted">Opportunity</span>
            <strong className="big">{s.opportunity}</strong>
            <span className="muted">/100 (somme exacte {pts(s.opportunityExact)})</span>
          </div>
          <div>
            <span className="muted">Risk</span>
            <strong className={`big risk-${riskLevel(s.risk)}`}>{s.risk}</strong>
            <span className="muted">
              /100{s.riskUncapped > s.risk ? ` (brut ${pts(s.riskUncapped)}, plafonné)` : ""}
            </span>
          </div>
          <div>
            <span className="muted">Étiquette</span>
            <LabelBadge label={s.label} />
            <span className="muted small-text">{s.labelReason}</span>
          </div>
        </div>

        <h3>Opportunity : points par catégorie</h3>
        <table className="small breakdown">
          <tbody>
            {CATEGORY_ORDER.map((k) => {
              const c = s.categories[k];
              return <CategoryRows key={k} category={c} />;
            })}
            <tr className="total">
              <td>Total</td>
              <td />
              <td className="num">
                {pts(s.opportunityExact)} → <strong>{s.opportunity}</strong> / 100
              </td>
            </tr>
          </tbody>
        </table>

        <h3>Risk : facteurs qui ont ajouté des points</h3>
        {s.riskFactors.length === 0 ? (
          <p className="muted">Aucun facteur de risque déclenché.</p>
        ) : (
          <table className="small breakdown">
            <tbody>
              {s.riskFactors.map((f) => (
                <tr key={f.key}>
                  <td>{f.label}</td>
                  <td className="muted">{f.input}</td>
                  <td className="num">+{pts(f.points)}</td>
                </tr>
              ))}
              <tr className="total">
                <td>Total</td>
                <td />
                <td className="num">
                  {pts(s.riskUncapped)}
                  {s.riskUncapped > s.risk ? " → plafonné à " : " → "}
                  <strong>{s.risk}</strong> / 100
                </td>
              </tr>
            </tbody>
          </table>
        )}

        {s.missingFields.length > 0 && (
          <p className="muted">
            Champs DEX Screener absents : <code>{s.missingFields.join(", ")}</code>. Ils ne sont jamais remplacés par 0.
          </p>
        )}

        <p className="disclaimer">
          {LABEL_DISCLAIMER} Les scores décrivent les données observées à{" "}
          {new Date(fetchedAt).toLocaleTimeString()} ; ils ne prédisent pas l'évolution du prix.
        </p>
      </aside>
    </div>
  );
}

function CategoryRows({ category: c }: { category: CategoryScore }) {
  return (
    <>
      <tr className="cat">
        <td>
          <strong>{c.label}</strong>
        </td>
        <td>
          <Bar value={c.points} max={c.max} />
        </td>
        <td className="num">
          <strong>
            {pts(c.points)} / {c.max}
          </strong>
        </td>
      </tr>
      {c.items.map((it) => (
        <tr key={it.key} className={it.missing ? "item missing" : "item"}>
          <td>{it.label}</td>
          <td>
            <span className={it.missing ? "absent" : undefined}>{it.input}</span>
            {it.note && <div className="muted small-text">{it.note}</div>}
          </td>
          <td className="num">
            {pts(it.points)} / {it.max}
          </td>
        </tr>
      ))}
      {c.cap && (
        <tr className="item capped">
          <td colSpan={2}>{c.cap.reason}</td>
          <td className="num">
            {c.uncapped > c.cap.points ? `${pts(c.uncapped)} → ${pts(c.points)}` : "non atteint"}
          </td>
        </tr>
      )}
    </>
  );
}

export function Bar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <span className="bar" title={`${pts(value)} / ${max}`}>
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

export function riskLevel(risk: number): "low" | "mid" | "high" {
  return risk >= 50 ? "high" : risk >= 25 ? "mid" : "low";
}
