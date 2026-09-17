// Real business data, taken from LS Barber's Google Business listing.
export const site = {
  name: "LS Barber",
  city: "Clermont-Ferrand",
  address: "21 Rue Saint-Hérem, 63000 Clermont-Ferrand",
  phoneDisplay: "06 64 63 43 76",
  phoneHref: "tel:+33664634376",
  hoursToday: "Ouvert · Ferme à 19:00",
  rating: 5.0,
  reviewCount: 37,
  category: "Salon de coiffure",
  mapsHref: "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent("LS Barber, 21 Rue Saint-Hérem, 63000 Clermont-Ferrand"),
  // All "Réserver" / "Prendre rendez-vous" CTAs route here — an internal
  // booking flow (src/pages/Reservation.tsx), never an external platform
  // and never tel:. See src/booking/ for the service-layer architecture.
  reservationPath: "/reservation",
};
