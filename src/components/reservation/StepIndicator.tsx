import "./reservation.css";

const LABELS = ["Service", "Date", "Heure", "Coordonnées", "Récapitulatif"];

export function StepIndicator({ current }: { current: number }) {
  return (
    <ol className="rsv-steps" aria-label="Étapes de réservation">
      {LABELS.map((label, i) => {
        const n = i + 1;
        const state = n < current ? "done" : n === current ? "active" : "upcoming";
        return (
          <li key={label} className={`rsv-steps__item rsv-steps__item--${state}`}>
            <span className="rsv-steps__n">{String(n).padStart(2, "0")}</span>
            <span className="rsv-steps__label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}
