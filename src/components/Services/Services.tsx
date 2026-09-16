import { useEffect, useRef } from "react";
import { gsap } from "../../lib/gsap";
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

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const ctx = gsap.context(() => {
      gsap.from(".service-row", {
        opacity: 0,
        y: 26,
        duration: 0.7,
        stagger: 0.08,
        ease: "power2.out",
        scrollTrigger: { trigger: section, start: "top 70%" },
      });
    }, section);
    return () => ctx.revert();
  }, []);

  return (
    <section className="services" ref={sectionRef}>
      <div className="container services__inner">
        <p className="eyebrow">Prestations</p>
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
