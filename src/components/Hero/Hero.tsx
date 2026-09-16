import { useEffect, useRef } from "react";
import { ArtPanel } from "../ArtPanel/ArtPanel";
import { gsap, ScrollTrigger, DESKTOP_QUERY } from "../../lib/gsap";
import { site } from "../../config/site";
import "./Hero.css";

export function Hero() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const typeRef = useRef<HTMLDivElement>(null);
  const atmosphereRef = useRef<HTMLDivElement>(null);
  const chairRef = useRef<HTMLDivElement>(null);
  const interfaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;

    const ctx = gsap.context(() => {
      // Entrance: layers arrive back-to-front so depth reads immediately.
      const tl = gsap.timeline({ delay: 0.15 });
      tl.from(typeRef.current, { yPercent: 8, opacity: 0, duration: 1.3, ease: "power3.out" })
        .from(atmosphereRef.current, { opacity: 0, duration: 1.6, ease: "power2.out" }, 0.1)
        .from(chairRef.current, { yPercent: 6, opacity: 0, scale: 1.04, duration: 1.3, ease: "power3.out" }, 0.2)
        .from(
          interfaceRef.current?.children ?? [],
          { y: 18, opacity: 0, duration: 0.9, stagger: 0.08, ease: "power2.out" },
          0.55,
        );

      // Scroll-driven transform: the whole composition settles/scales as the
      // hero scrolls away, instead of just cutting to the next section.
      gsap.timeline({
        scrollTrigger: { trigger: section, start: "top top", end: "bottom top", scrub: true },
      })
        .to(typeRef.current, { yPercent: -14, scale: 1.12, opacity: 0.14, ease: "none" }, 0)
        .to(chairRef.current, { yPercent: -22, scale: 1.06, ease: "none" }, 0)
        .to(atmosphereRef.current, { opacity: 0.4, ease: "none" }, 0)
        .to(interfaceRef.current, { opacity: 0, y: -30, ease: "none" }, 0);

      gsap.matchMedia().add(DESKTOP_QUERY, () => {
        const setBg = gsap.quickTo(typeRef.current, "x", { duration: 0.9, ease: "power3.out" });
        const setBgY = gsap.quickTo(typeRef.current, "y", { duration: 0.9, ease: "power3.out" });
        const setChair = gsap.quickTo(chairRef.current, "x", { duration: 0.7, ease: "power3.out" });
        const setChairY = gsap.quickTo(chairRef.current, "y", { duration: 0.7, ease: "power3.out" });

        const onMove = (e: MouseEvent) => {
          const nx = e.clientX / window.innerWidth - 0.5;
          const ny = e.clientY / window.innerHeight - 0.5;
          setBg(nx * 14);
          setBgY(ny * 10);
          setChair(nx * -22);
          setChairY(ny * -14);
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

      <div className="hero__stage">
        <div className="hero__type" ref={typeRef} aria-hidden="true">
          <span className="hero__type-line">LS</span>
          <span className="hero__type-line hero__type-line--outline">BARBER</span>
        </div>

        <div className="hero__atmosphere" ref={atmosphereRef} aria-hidden="true" />

        <div className="hero__chair" ref={chairRef}>
          <ArtPanel
            src="hero-chair.jpg"
            tone="chair"
            alt="Fauteuil de coiffure LS Barber"
            className="hero__chair-panel"
          />
        </div>
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
