import { useEffect, useRef } from "react";
import { ArtPanel } from "../ArtPanel/ArtPanel";
import { gsap, ScrollTrigger, DESKTOP_QUERY } from "../../lib/gsap";
import { site } from "../../config/site";
import "./Hero.css";

export function Hero() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLDivElement>(null);
  const typeRef = useRef<HTMLDivElement>(null);
  const interfaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;

    const ctx = gsap.context(() => {
      // Entrance: photo settles in first, type and copy arrive after —
      // depth reads immediately without a pile of simultaneous motion.
      const tl = gsap.timeline({ delay: 0.15 });
      tl.from(mediaRef.current, { scale: 1.08, opacity: 0, duration: 1.5, ease: "power2.out" })
        .from(typeRef.current?.children ?? [], { yPercent: 110, duration: 1.1, stagger: 0.08, ease: "power3.out" }, 0.35)
        .from(
          interfaceRef.current?.children ?? [],
          { y: 18, opacity: 0, duration: 0.9, stagger: 0.08, ease: "power2.out" },
          0.7,
        );

      // Scroll-driven settle: the photo slowly zooms (Ken Burns) while the
      // copy lifts and fades, so the hero transforms rather than just cuts.
      gsap.timeline({
        scrollTrigger: { trigger: section, start: "top top", end: "bottom top", scrub: true },
      })
        .to(mediaRef.current, { scale: 1.14, ease: "none" }, 0)
        .to(typeRef.current, { yPercent: -16, opacity: 0.25, ease: "none" }, 0)
        .to(interfaceRef.current, { opacity: 0, y: -24, ease: "none" }, 0);

      gsap.matchMedia().add(DESKTOP_QUERY, () => {
        // Focus-pull exit: only on desktop, where the blur cost is trivial.
        gsap.to(mediaRef.current, {
          filter: "blur(5px) brightness(0.8)",
          ease: "none",
          scrollTrigger: { trigger: section, start: "top top", end: "bottom top", scrub: true },
        });

        const setMediaX = gsap.quickTo(mediaRef.current, "x", { duration: 1, ease: "power3.out" });
        const setMediaY = gsap.quickTo(mediaRef.current, "y", { duration: 1, ease: "power3.out" });
        const setTypeX = gsap.quickTo(typeRef.current, "x", { duration: 0.7, ease: "power3.out" });
        const setTypeY = gsap.quickTo(typeRef.current, "y", { duration: 0.7, ease: "power3.out" });

        const onMove = (e: MouseEvent) => {
          const nx = e.clientX / window.innerWidth - 0.5;
          const ny = e.clientY / window.innerHeight - 0.5;
          setMediaX(nx * 8);
          setMediaY(ny * 6);
          setTypeX(nx * -18);
          setTypeY(ny * -12);
        };

        section.addEventListener("mousemove", onMove);
        return () => section.removeEventListener("mousemove", onMove);
      });
    }, section);

    return () => {
      ctx.revert();
      ScrollTrigger.getAll().forEach((t) => t.kill());
    };
  }, []);

  return (
    <section id="top" className="hero" ref={sectionRef}>
      <h1 className="visually-hidden">LS Barber — salon de coiffure à Clermont-Ferrand</h1>

      <div className="hero__media" ref={mediaRef}>
        <ArtPanel
          src="hero-chair.jpg"
          tone="chair"
          alt="Fauteuil de coiffure LS Barber, dans le salon à Clermont-Ferrand"
          className="hero__media-panel"
        />
        <div className="hero__glow" aria-hidden="true" />
      </div>

      <div className="hero__scrim" aria-hidden="true" />

      <div className="hero__type" ref={typeRef} aria-hidden="true">
        <span className="hero__type-line">LS</span>
        <span className="hero__type-line hero__type-line--outline">BARBER</span>
      </div>

      <div className="hero__interface" ref={interfaceRef}>
        <p className="eyebrow">{site.city}</p>
        <p className="hero__tagline">Un fauteuil. Un geste précis. Une identité affirmée.</p>
        <div className="hero__actions">
          <a className="btn btn-solid" href={site.bookingUrl || site.phoneHref}>
            Prendre rendez-vous
          </a>
          <a className="btn" href="#craft">
            Découvrir le métier
          </a>
        </div>
      </div>

      <div className="hero__scroll-cue" aria-hidden="true">
        <span className="hero__scroll-line" />
        Défiler
      </div>
    </section>
  );
}
