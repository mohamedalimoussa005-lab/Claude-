import { NO_FILTERS } from "../scoring/filters.ts";
import type { ScoreFilters } from "../scoring/filters.ts";

interface Field {
  key: keyof ScoreFilters;
  label: string;
  unit: string;
  step: number;
}

const FIELDS: Field[] = [
  { key: "maxAgeMinutes", label: "Âge max", unit: "min", step: 5 },
  { key: "minMarketCap", label: "Market cap min", unit: "$", step: 1000 },
  { key: "maxMarketCap", label: "Market cap max", unit: "$", step: 1000 },
  { key: "minLiquidity", label: "Liquidité min", unit: "$", step: 1000 },
  { key: "minVolumeH1", label: "Volume 1 h min", unit: "$", step: 1000 },
  { key: "minOpportunity", label: "Opportunity min", unit: "/100", step: 5 },
  { key: "maxRisk", label: "Risk max", unit: "/100", step: 5 },
];

export function FiltersPanel({ value, onChange }: { value: ScoreFilters; onChange: (f: ScoreFilters) => void }) {
  const active = FIELDS.filter((f) => value[f.key] !== null).length;
  return (
    <section className="filters">
      {FIELDS.map((f) => (
        <label key={f.key}>
          <span>
            {f.label} <span className="muted">({f.unit})</span>
          </span>
          <input
            type="number"
            min={0}
            step={f.step}
            placeholder="—"
            value={value[f.key] ?? ""}
            onChange={(e) => {
              const raw = e.target.value.trim();
              const n = raw === "" ? null : Number(raw);
              onChange({ ...value, [f.key]: n !== null && Number.isFinite(n) ? n : null });
            }}
          />
        </label>
      ))}
      <button className="secondary" onClick={() => onChange(NO_FILTERS)} disabled={active === 0}>
        Réinitialiser{active ? ` (${active})` : ""}
      </button>
      <p className="muted small-text">
        Une paire dont la valeur testée est absente (ex. liquidité non fournie) est exclue quand ce filtre est actif.
      </p>
    </section>
  );
}
