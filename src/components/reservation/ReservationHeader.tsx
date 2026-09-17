import { Link } from "react-router-dom";
import { site } from "../../config/site";
import "./reservation.css";

export function ReservationHeader() {
  return (
    <header className="rsv-header">
      <div className="rsv-header__row">
        <Link to="/" className="rsv-header__mark" aria-label="LS Barber — retour à l'accueil">
          LS
        </Link>
        <div className="rsv-header__actions">
          <a href={site.phoneHref} className="rsv-header__phone">
            {site.phoneDisplay}
          </a>
          <Link to="/" className="rsv-header__back">
            Retour au site
          </Link>
        </div>
      </div>
      <p className="rsv-header__demo">Démonstration — non connectée à un système de réservation réel</p>
    </header>
  );
}
