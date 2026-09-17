import { useEffect, useRef } from "react";
import { ArtPanel } from "../ArtPanel/ArtPanel";
import { SplitWords } from "../SplitWords/SplitWords";
import { gsap, DESKTOP_QUERY } from "../../lib/gsap";
import { site } from "../../config/site";
import "./Services.css";

const SERVICES = [
  { n: "01", name: "Coupe homme", detail: "Ciseaux, tondeuse, dégradé sur mesure" },
  { n: "02", name: "Taille de barbe", detail: "Ligne nette, rasoir, finitions à chaud" },
  { n: "03", name: "Coupe + Barbe", detail: "Le rituel complet" },
  { n: "04", name: "Coupe enfant", detail: "Même précision, même exigence" },
];

export function Services() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const visualRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const ctx = gsap.context(() => {
      gsap.from(visualRef.current, {
        scale: 1.1,
        opacity: 0,
        duration: 1.2,
        ease: "power2.out",
        scrollTrigger: { trigger: section, start: "top 78%" },
      });

      gsap.from(".split-words__word", {
        yPercent: 110,
        duration: 0.9,
        ease: "power3.out",
        stagger: 0.05,
        scrollTrigger: { trigger: section, start: "top 65%" },
      });

      gsap.from(".service-row", {
        opacity: 0,
        y: 26,
        duration: 0.7,
        stagger: 0.08,
        ease: "power2.out",
        scrollTrigger: { trigger: ".services__list", start: "top 82%" },
      });

      gsap.matchMedia().add(DESKTOP_QUERY, () => {
        gsap.to(visualRef.current, {
          scale: 1.06,
          ease: "none",
          scrollTrigger: { trigger: section, start: "top bottom", end: "bottom top", scrub: true },
        });
      });
    }, section);
    return () => ctx.revert();
  }, []);

  return (
    <section className="services" ref={sectionRef}>
      <div className="services__hero">
        <div className="services__visual" ref={visualRef}>
          <ArtPanel
            src="barber-tools.jpg"
            tone="tools"
            alt="Outils de coiffure LS Barber : tondeuse, ciseaux, peigne"
            className="services__panel"
          />
          <div className="services__visual-scrim" aria-hidden="true" />
        </div>
        <div className="services__visual-type">
          <p className="eyebrow">Le nécessaire</p>
          <SplitWords as="h2" text="Des outils choisis, pas accumulés." className="services__heading" />
        </div>
      </div>

      <div className="container services__inner">
        <ul className="services__list">
          {SERVICES.map((s) => (
            <li className="service-row" key={s.n}>
              <span className="service-row__n">{s.n}</span>
              <span className="service-row__name">{s.name}</span>
              <span className="service-row__detail">{s.detail}</span>
            </li>
          ))}
        </ul>
        <p className="services__note">
          Tarifs communiqués par téléphone —{" "}
          <a href={site.phoneHref} className="services__note-link">
            {site.phoneDisplay}
          </a>
        </p>
      </div>
    </section>
  );
}
