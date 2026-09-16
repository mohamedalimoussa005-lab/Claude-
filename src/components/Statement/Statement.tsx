import { useEffect, useRef } from "react";
import { gsap } from "../../lib/gsap";
import "./Statement.css";

const WORDS = ["PRÉCISION.", "STYLE.", "IDENTITÉ."];

export function Statement() {
  const sectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;

    const ctx = gsap.context(() => {
      const words = gsap.utils.toArray<HTMLElement>(".statement__word", section);
      gsap.set(words.slice(1), { opacity: 0, y: 24 });

      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: section,
          start: "top top",
          end: "+=180%",
          scrub: true,
          pin: true,
        },
      });

      words.forEach((word, i) => {
        if (i > 0) {
          tl.to(words[i - 1], { opacity: 0, y: -24, duration: 0.3, ease: "power1.in" });
        }
        if (i > 0) {
          tl.to(word, { opacity: 1, y: 0, duration: 0.35, ease: "power2.out" }, "<");
        }
        tl.to({}, { duration: 0.35 }); // hold
      });
    }, section);

    return () => ctx.revert();
  }, []);

  return (
    <section className="statement" ref={sectionRef}>
      <div className="statement__stage">
        {WORDS.map((word) => (
          <span className="statement__word" key={word}>
            {word}
          </span>
        ))}
      </div>
    </section>
  );
}
