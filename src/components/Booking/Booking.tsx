import { useEffect, useRef } from "react";
import { SplitWords } from "../SplitWords/SplitWords";
import { gsap } from "../../lib/gsap";
import { site } from "../../config/site";
import "./Booking.css";

export function Booking() {
  const sectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const ctx = gsap.context(() => {
      gsap.from(".split-words__word", {
        yPercent: 110,
        duration: 1,
        ease: "power3.out",
        stagger: 0.04,
        scrollTrigger: { trigger: section, start: "top 70%" },
      });
      gsap.from(".booking__sub, .booking__actions, .booking__contact", {
        opacity: 0,
        y: 16,
        duration: 0.8,
        stagger: 0.1,
        ease: "power2.out",
        scrollTrigger: { trigger: section, start: "top 65%" },
      });
    }, section);
    return () => ctx.revert();
  }, []);

  return (
    <section id="booking" className="booking" ref={sectionRef}>
      <div className="container booking__inner">
        <SplitWords as="h2" text="Prendre rendez-vous." className="booking__heading" />
        <p className="booking__sub">
          {site.hoursToday} · {site.address}
        </p>

        <div className="booking__actions">
          <a href={site.bookingUrl || site.phoneHref} className="btn btn-solid booking__cta">
            {site.bookingUrl ? "Réserver en ligne" : "Appeler pour réserver"}
          </a>
          <a href={site.mapsHref} target="_blank" rel="noreferrer" className="btn">
            Itinéraire
          </a>
        </div>

        <div className="booking__contact">
          <a href={site.phoneHref}>{site.phoneDisplay}</a>
          <span className="booking__divider" aria-hidden="true" />
          <span>{site.category} · {site.city}</span>
        </div>
      </div>

      <footer className="booking__footer">
        <span>© {new Date().getFullYear()} {site.name}</span>
        <span>{site.address}</span>
      </footer>
    </section>
  );
}
