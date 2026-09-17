import type { CustomerInfo, Service } from "../../booking/types";
import { formatLongDateFR } from "../../booking/availability";
import "./reservation.css";

interface SummaryStepProps {
  service: Service;
  dateISO: string;
  time: string;
  customer: CustomerInfo;
  onEditStep: (step: number) => void;
  submitting: boolean;
  error: string | null;
  onConfirm: () => void;
}

export function SummaryStep({ service, dateISO, time, customer, onEditStep, submitting, error, onConfirm }: SummaryStepProps) {
  return (
    <div className="rsv-step">
      <p className="eyebrow">Étape 05</p>
      <h1 className="rsv-step__title">Récapitulatif.</h1>

      <dl className="rsv-summary">
        <div className="rsv-summary__row">
          <div>
            <dt>Service</dt>
            <dd>
              {service.name} — {service.price} €
            </dd>
          </div>
          <button type="button" className="rsv-summary__edit" onClick={() => onEditStep(1)}>
            Modifier
          </button>
        </div>

        <div className="rsv-summary__row">
          <div>
            <dt>Date &amp; heure</dt>
            <dd>
              {formatLongDateFR(dateISO)} — {time}
            </dd>
          </div>
          <button type="button" className="rsv-summary__edit" onClick={() => onEditStep(2)}>
            Modifier
          </button>
        </div>

        <div className="rsv-summary__row">
          <div>
            <dt>Coordonnées</dt>
            <dd>
              {customer.firstName} {customer.lastName}
              <br />
              {customer.phone}
              {customer.email ? <> · {customer.email}</> : null}
            </dd>
          </div>
          <button type="button" className="rsv-summary__edit" onClick={() => onEditStep(4)}>
            Modifier
          </button>
        </div>
      </dl>

      {error && <p className="rsv-summary__error">{error}</p>}

      <button type="button" className="btn btn-solid rsv-confirm-btn" onClick={onConfirm} disabled={submitting}>
        {submitting ? "Confirmation…" : "Confirmer le rendez-vous"}
      </button>
    </div>
  );
}
