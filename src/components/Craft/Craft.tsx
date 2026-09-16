import { useEffect, useRef } from "react";
import { ArtPanel } from "../ArtPanel/ArtPanel";
import { SplitWords } from "../SplitWords/SplitWords";
import { gsap } from "../../lib/gsap";
import "./Craft.css";

export function Craft() {
  const sectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;

    const ctx = gsap.context(() => {
      gsap.from(".split-words__word", {
        yPercent: 110,
        duration: 0.9,
        ease: "power3.out",
        stagger: 0.05,
        scrollTrigger: { trigger: section, start: "top 75%" },
      });

      gsap.utils.toArray<HTMLElement>(".craft__panel", section).forEach((panel, i) => {
        gsap.from(panel, {
          clipPath: "inset(0% 0% 100% 0%)",
          duration: 1.1,
          ease: "power3.out",
          delay: i * 0.12,
          scrollTrigger: { trigger: panel, start: "top 85%" },
        });
        gsap.to(panel, {
          yPercent: -8,
          ease: "none",
          scrollTrigger: { trigger: panel, start: "top bottom", end: "bottom top", scrub: true },
        });
      });
    }, section);

    return () => ctx.revert();
  }, []);

  return (
    <section id="craft" className="craft" ref={sectionRef}>
      <div className="container craft__grid">
        <div className="craft__copy">
          <p className="eyebrow">Le métier</p>
          <SplitWords as="h2" text="Chaque coupe est une décision, pas un hasard." className="craft__heading" />
          <p className="craft__lead">
            À LS Barber, le geste prime sur la vitesse. Ligne de nuque nette, dégradé maîtrisé, finitions
            au rasoir — la précision se voit autant qu'elle se ressent.
          </p>
        </div>

        <div className="craft__visuals">
          <ArtPanel
            src="craft-detail.jpg"
            tone="detail"
            alt="Détail d'une coupe en cours chez LS Barber"
            className="craft__panel craft__panel--tall"
          />
          <ArtPanel
            src="barber-tools.jpg"
            tone="tools"
            alt="Outils de coiffure LS Barber"
            className="craft__panel craft__panel--wide"
          />
        </div>
      </div>
    </section>
  );
}
