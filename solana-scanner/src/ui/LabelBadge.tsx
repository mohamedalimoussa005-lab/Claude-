import type { Label } from "../scoring/score.ts";

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
