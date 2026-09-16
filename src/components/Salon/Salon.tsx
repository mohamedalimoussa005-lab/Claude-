import { useEffect, useRef } from "react";
import { ArtPanel } from "../ArtPanel/ArtPanel";
import { SplitWords } from "../SplitWords/SplitWords";
import { gsap } from "../../lib/gsap";
import { site } from "../../config/site";
import "./Salon.css";

export function Salon() {
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
      gsap.from(".salon__panel", {
        clipPath: "inset(0% 0% 100% 0%)",
        duration: 1.1,
        ease: "power3.out",
        scrollTrigger: { trigger: ".salon__panel", start: "top 85%" },
      });
    }, section);
    return () => ctx.revert();
  }, []);

  return (
    <section id="salon" className="salon" ref={sectionRef}>
      <ArtPanel
        src="salon-interior.jpg"
        tone="interior"
        alt="Intérieur du salon LS Barber à Clermont-Ferrand"
        className="salon__panel"
      />
      <div className="salon__overlay" />

      <div className="container salon__content">
        <p className="eyebrow">Le salon</p>
        <SplitWords as="h2" text="Un lieu pensé pour prendre le temps." className="salon__heading" />
        <p className="salon__address">
          {site.address}
          <br />
          {site.hoursToday}
        </p>
        <a href={site.mapsHref} target="_blank" rel="noreferrer" className="btn salon__directions">
          Itinéraire
        </a>
      </div>
    </section>
  );
}
