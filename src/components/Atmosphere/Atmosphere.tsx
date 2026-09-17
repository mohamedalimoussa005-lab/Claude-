import { useEffect, useRef } from "react";
import { ArtPanel } from "../ArtPanel/ArtPanel";
import { SplitWords } from "../SplitWords/SplitWords";
import { gsap, DESKTOP_QUERY } from "../../lib/gsap";
import "./Atmosphere.css";

export function Atmosphere() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const ctx = gsap.context(() => {
      gsap.from(mediaRef.current, {
        clipPath: "inset(0% 0% 100% 0%)",
        duration: 1.3,
        ease: "power3.out",
        scrollTrigger: { trigger: section, start: "top 80%" },
      });

      gsap.from(".split-words__word", {
        yPercent: 110,
        duration: 0.9,
        ease: "power3.out",
        stagger: 0.05,
        scrollTrigger: { trigger: section, start: "top 65%" },
      });

      gsap.matchMedia().add(DESKTOP_QUERY, () => {
        gsap.to(mediaRef.current, {
          yPercent: -6,
          ease: "none",
          scrollTrigger: { trigger: section, start: "top bottom", end: "bottom top", scrub: true },
        });
      });
    }, section);
    return () => ctx.revert();
  }, []);

  return (
    <section id="atmosphere" className="atmosphere" ref={sectionRef}>
      <div className="atmosphere__media" ref={mediaRef}>
        <ArtPanel
          src="barber-action.jpg"
          tone="action"
          alt="Coupe en cours, ambiance du salon"
          className="atmosphere__panel"
        />
      </div>
      <div className="atmosphere__scrim" aria-hidden="true" />

      <div className="atmosphere__content">
        <p className="eyebrow">Le geste, au quotidien</p>
        <SplitWords as="h2" text="MÊME EXIGENCE." className="atmosphere__heading" />
        <SplitWords as="h2" text="CHAQUE JOUR." className="atmosphere__heading" />
      </div>
    </section>
  );
}
