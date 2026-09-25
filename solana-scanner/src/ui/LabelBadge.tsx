import type { ConfidenceLevel, Label } from "../scoring/score.ts";

const TITLE: Record<Label, string> = {
  WATCH: "Setup correct à observer. Étiquette descriptive, pas une recommandation d'achat.",
  MOMENTUM: "Momentum observé fort avec risque modéré. Étiquette descriptive, pas une recommandation d'achat.",
  "HIGH RISK": "Risque élevé selon les données observées. Étiquette descriptive.",
};

export function LabelBadge({ label }: { label: Label | null }) {
  if (!label) return <span className="muted">—</span>;
  const cls = label === "HIGH RISK" ? "high-risk" : label.toLowerCase();
  return (
    <span className={`badge ${cls}`} title={TITLE[label]}>
      {label}
    </span>
  );
}

const CONFIDENCE_TITLE: Record<ConfidenceLevel, string> = {
  HIGH: "Données complètes et cohérentes, historique et activité suffisants. Pas une recommandation d'achat.",
  MEDIUM: "Données partielles, historique court ou anomalies : scores à interpréter avec prudence.",
  LOW: "Peu de données fiables : les scores décrivent un signal fragile.",
};

export function ConfidenceBadge({ level }: { level: ConfidenceLevel }) {
  return (
    <span className={`badge conf-${level.toLowerCase()}`} title={CONFIDENCE_TITLE[level]}>
      {level}
    </span>
  );
}
