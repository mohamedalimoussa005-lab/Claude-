import { Link } from "react-router-dom";
import type { BookingConfirmation } from "../../booking/types";
import { formatLongDateFR } from "../../booking/availability";
import { site } from "../../config/site";
import "./reservation.css";

interface ConfirmationStepProps {
  confirmation: BookingConfirmation;
  onReset: () => void;
}

export function ConfirmationStep({ confirmation, onReset }: ConfirmationStepProps) {
  const { service, date, time, customer } = confirmation;
  const lastInitial = customer.lastName.trim().charAt(0).toUpperCase();

  return (
    <div className="rsv-step rsv-step--confirmation">
      <p className="eyebrow">Étape 06</p>
      <h1 className="rsv-step__title">Merci, {customer.firstName}.</h1>

      <p className="rsv-confirmation__recap">
        {service.name}
        <br />
        {formatLongDateFR(date)}
        <br />
        {time}
        <br />
        {customer.firstName} {lastInitial}.
      </p>

      <p className="rsv-confirmation__demo">Mode démonstration — aucun rendez-vous réel n'est enregistré.</p>

      <div className="rsv-confirmation__actions">
        <button type="button" className="btn btn-solid" onClick={onReset}>
          Nouveau rendez-vous
        </button>
        <Link to="/" className="btn">
          Retour à l'accueil
        </Link>
      </div>

      <p className="rsv-confirmation__phone">
        Une question ? Appelez-nous —{" "}
        <a href={site.phoneHref}>{site.phoneDisplay}</a>
      </p>
    </div>
  );
}
