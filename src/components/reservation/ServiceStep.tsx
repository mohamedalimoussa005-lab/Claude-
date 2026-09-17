import type { Service } from "../../booking/types";
import "./reservation.css";

interface ServiceStepProps {
  services: Service[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function ServiceStep({ services, loading, selectedId, onSelect }: ServiceStepProps) {
  return (
    <div className="rsv-step">
      <p className="eyebrow">Étape 01</p>
      <h1 className="rsv-step__title">Choisissez un service.</h1>

      {loading ? (
        <p className="rsv-step__loading">Chargement des services…</p>
      ) : (
        <ul className="rsv-service-list">
          {services.map((service) => (
            <li key={service.id}>
              <button
                type="button"
                className={`rsv-service-card ${selectedId === service.id ? "rsv-service-card--selected" : ""}`}
                onClick={() => onSelect(service.id)}
                aria-pressed={selectedId === service.id}
              >
                <span className="rsv-service-card__name">{service.name}</span>
                <span className="rsv-service-card__detail">{service.detail}</span>
                <span className="rsv-service-card__meta">
                  {service.durationMinutes} min · {service.price} €
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
