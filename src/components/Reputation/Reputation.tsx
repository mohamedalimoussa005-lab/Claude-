import { useEffect, useRef } from "react";
import { gsap } from "../../lib/gsap";
import { site } from "../../config/site";
import "./Reputation.css";

export function Reputation() {
  const sectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const ctx = gsap.context(() => {
      gsap.from(".reputation__score, .reputation__meta, .reputation__stars", {
        opacity: 0,
        y: 20,
        duration: 0.8,
        stagger: 0.08,
        ease: "power2.out",
        scrollTrigger: { trigger: section, start: "top 75%" },
      });
    }, section);
    return () => ctx.revert();
  }, []);

  return (
    <section className="reputation" ref={sectionRef}>
      <div className="container reputation__inner">
        <p className="reputation__score">{site.rating.toFixed(1)}</p>
        <div className="reputation__stars" aria-hidden="true">
          {"★★★★★"}
        </div>
        <p className="reputation__meta">
          {site.reviewCount} avis Google · {site.category}
        </p>
        <a href={site.mapsHref} target="_blank" rel="noreferrer" className="reputation__link">
          Voir les avis sur Google →
        </a>
      </div>
    </section>
  );
}
