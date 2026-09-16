import { useEffect, useRef } from "react";
import { ArtPanel } from "../ArtPanel/ArtPanel";
import { SplitWords } from "../SplitWords/SplitWords";
import { gsap } from "../../lib/gsap";
import "./Gallery.css";

const CUTS = [
  { src: "gallery-1.jpg", label: "Dégradé net" },
  { src: "gallery-2.jpg", label: "Barbe sculptée" },
  { src: "gallery-3.jpg", label: "Coupe classique" },
  { src: "gallery-4.jpg", label: "Finitions au rasoir" },
];

export function Gallery() {
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

      gsap.utils.toArray<HTMLElement>(".gallery__item", section).forEach((item, i) => {
        gsap.from(item, {
          opacity: 0,
          y: 36,
          scale: 0.96,
          duration: 0.9,
          delay: (i % 2) * 0.1,
          ease: "power3.out",
          scrollTrigger: { trigger: item, start: "top 88%" },
        });
      });
    }, section);
    return () => ctx.revert();
  }, []);

  return (
    <section id="gallery" className="gallery" ref={sectionRef}>
      <div className="container">
        <p className="eyebrow">Coupes réalisées</p>
        <SplitWords as="h2" text="La preuve, en image." className="gallery__heading" />
      </div>

      <div className="container gallery__grid">
        <ArtPanel
          src="barber-action.jpg"
          tone="action"
          alt="Barbier au travail chez LS Barber"
          className="gallery__item gallery__item--feature"
        />
        {CUTS.map((cut) => (
          <figure className="gallery__item gallery__item--cut" key={cut.src}>
            <ArtPanel src={cut.src} tone="gallery" alt={cut.label} className="gallery__item-panel" />
            <figcaption className="gallery__caption">{cut.label}</figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
