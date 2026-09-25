import { useEffect } from "react";
import { LABEL_DISCLAIMER } from "../scoring/config.ts";
import { CATEGORY_ORDER } from "../scoring/score.ts";
import type { CategoryScore, ScoredPair } from "../scoring/score.ts";
import { ConfidenceBadge, LabelBadge } from "./LabelBadge.tsx";
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
  const { positive, negative, anomalies } = s.signals;

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="detail" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`Why this score: ${name}`}>
        <button className="close" onClick={onClose} aria-label="Fermer">
          ×
        </button>
        <h2>Why this score? — {name}</h2>
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
            <strong className="big">{s.opportunity}/100</strong>
            <span className="muted small-text">force du setup observé</span>
          </div>
          <div>
            <span className="muted">Risk</span>
            <strong className={`big risk-${riskLevel(s.risk)}`}>{s.risk}/100</strong>
            <span className="muted small-text">niveau de risque détecté</span>
          </div>
          <div>
            <span className="muted">Quality</span>
            <strong className={`big quality-${qualityLevel(s.quality)}`}>{s.quality}/100</strong>
            <span className="muted small-text">crédibilité des données et de l'activité</span>
          </div>
          <div>
            <span className="muted">Confidence</span>
            <ConfidenceBadge level={s.confidence.level} />
            <span className="muted small-text">
              {s.confidence.points}/100{s.confidence.caps.length ? ` · plafonné : ${s.confidence.caps.join(", ")}` : ""}
            </span>
          </div>
        </div>
        <p className="muted small-text">
          Étiquette : <LabelBadge label={s.label} /> {s.labelReason}
        </p>

        <SignalList title="Positive signals" cls="pos" items={positive} empty="Aucun signal positif marqué." />
        <SignalList title="Negative signals" cls="neg" items={negative} empty="Aucun signal négatif marqué." />
        <h3>Anomalies</h3>
        {anomalies.length === 0 ? (
          <p className="muted">Aucune anomalie détectée.</p>
        ) : (
          <ul className="signals anomalies">
            {anomalies.map((a) => (
              <li key={a.key}>
                <strong>{a.title}</strong>
                <div className="muted small-text">{a.detail}</div>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small-text">
          Une anomalie signale un motif inhabituel dans les données ; elle ne prouve pas une manipulation.
        </p>

        <details open>
          <summary>Opportunity : {s.opportunity}/100, points par catégorie</summary>
          <table className="small breakdown">
            <tbody>
              {CATEGORY_ORDER.map((k) => (
                <CategoryRows key={k} category={s.categories[k]} />
              ))}
              <tr className="total">
                <td>Total</td>
                <td />
                <td className="num">
                  {pts(s.opportunityExact)} → <strong>{s.opportunity}</strong> / 100
                </td>
              </tr>
            </tbody>
          </table>
        </details>

        <details>
          <summary>Quality : {s.quality}/100, déductions</summary>
          {s.qualityDetail.deductions.length === 0 ? (
            <p className="muted">Aucune déduction : 100/100.</p>
          ) : (
            <table className="small breakdown">
              <tbody>
                <tr className="cat">
                  <td>Départ</td>
                  <td />
                  <td className="num">100</td>
                </tr>
                {s.qualityDetail.deductions.map((d) => (
                  <tr key={d.key} className="item">
                    <td>{d.label}</td>
                    <td>
                      {d.detail}
                      {d.anomaly && d.points >= 5 && <div className="small-text warn-text">{d.anomaly}</div>}
                    </td>
                    <td className="num">−{pts(d.points)}</td>
                  </tr>
                ))}
                <tr className="total">
                  <td>Quality</td>
                  <td />
                  <td className="num">
                    <strong>{s.quality}</strong> / 100
                  </td>
                </tr>
              </tbody>
            </table>
          )}
        </details>

        <details>
          <summary>Confidence : {s.confidence.level}</summary>
          <table className="small breakdown">
            <tbody>
              {s.confidence.parts.map((part) => (
                <tr key={part.label} className="item">
                  <td>{part.label}</td>
                  <td>{part.detail}</td>
                  <td className="num">
                    {part.points > 0 ? pts(part.points) : `${pts(part.points)}`}
                    {part.max > 0 ? ` / ${part.max}` : ""}
                  </td>
                </tr>
              ))}
              <tr className="total">
                <td>Total</td>
                <td className="muted small-text">HIGH ≥ 70, MEDIUM ≥ 45{s.confidence.caps.length ? ` · plafonds : ${s.confidence.caps.join(", ")}` : ""}</td>
                <td className="num">
                  {s.confidence.points} → <strong>{s.confidence.level}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        </details>

        <details>
          <summary>Risk : {s.risk}/100, facteurs</summary>
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
        </details>

        <p className="disclaimer">
          {LABEL_DISCLAIMER} Scores calculés sur les données observées à {new Date(fetchedAt).toLocaleTimeString()} ; ils ne
          prédisent pas l'évolution du prix. Les données brutes DEX Screener ne sont pas modifiées.
        </p>
      </aside>
    </div>
  );
}

function SignalList({ title, cls, items, empty }: { title: string; cls: string; items: string[]; empty: string }) {
  return (
    <>
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul className={`signals ${cls}`}>
          {items.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      )}
    </>
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
          <td className="num">{c.uncapped > c.cap.points ? `${pts(c.uncapped)} → ${pts(c.points)}` : "non atteint"}</td>
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

export function qualityLevel(quality: number): "low" | "mid" | "high" {
  return quality >= 70 ? "high" : quality >= 40 ? "mid" : "low";
}
