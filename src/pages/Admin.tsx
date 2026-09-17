import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getAdminBookingService } from "../booking/adminBookingService";
import type { BookingConfirmation } from "../booking/types";
import { addDays, formatDateISO, formatLongDateFR } from "../booking/availability";
import "./Admin.css";

const FUTURE_TABS = ["Disponibilités", "Services", "Horaires"];

function DayList({ dateISO, label }: { dateISO: string; label: string }) {
  const [bookings, setBookings] = useState<BookingConfirmation[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAdminBookingService()
      .listBookingsForDate(dateISO)
      .then((list) => {
        if (!cancelled) setBookings(list);
      });
    return () => {
      cancelled = true;
    };
  }, [dateISO]);

  return (
    <section className="admin-day">
      <h2 className="admin-day__title">{label}</h2>
      {bookings === null ? (
        <p className="admin-day__empty">Chargement…</p>
      ) : bookings.length === 0 ? (
        <p className="admin-day__empty">Aucun rendez-vous.</p>
      ) : (
        <ul className="admin-day__list">
          {bookings.map((b) => (
            <li key={b.id} className="admin-row">
              <span className="admin-row__time">{b.time}</span>
              <span className="admin-row__name">
                {b.customer.firstName} {b.customer.lastName}
              </span>
              <span className="admin-row__service">{b.service.name}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AdminPage() {
  const today = useMemo(() => new Date(), []);
  const days = useMemo(
    () => [
      { dateISO: formatDateISO(today), label: "Aujourd'hui" },
      { dateISO: formatDateISO(addDays(today, 1)), label: formatLongDateFR(formatDateISO(addDays(today, 1))) },
      { dateISO: formatDateISO(addDays(today, 2)), label: formatLongDateFR(formatDateISO(addDays(today, 2))) },
    ],
    [today],
  );

  return (
    <div className="admin-page">
      <header className="admin-header">
        <div className="admin-header__row">
          <Link to="/" className="admin-header__mark">
            LS
          </Link>
          <Link to="/" className="admin-header__back">
            Retour au site
          </Link>
        </div>
        <p className="admin-header__badge">
          Démo — aucune authentification réelle. En production, cette page doit être protégée par une session
          propriétaire authentifiée (voir docs/BOOKING_BACKEND.md).
        </p>
      </header>

      <nav className="admin-tabs">
        <span className="admin-tabs__item admin-tabs__item--active">Rendez-vous</span>
        {FUTURE_TABS.map((tab) => (
          <span key={tab} className="admin-tabs__item admin-tabs__item--soon">
            {tab} <em>bientôt</em>
          </span>
        ))}
      </nav>

      <main className="admin-main">
        {days.map((d) => (
          <DayList key={d.dateISO} dateISO={d.dateISO} label={d.label} />
        ))}
      </main>
    </div>
  );
}
