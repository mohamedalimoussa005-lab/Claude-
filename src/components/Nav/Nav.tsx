import { useEffect, useState } from "react";
import { site } from "../../config/site";
import "./Nav.css";

const LINKS = [
  { href: "#craft", label: "Le métier" },
  { href: "#gallery", label: "Coupes" },
  { href: "#salon", label: "Le salon" },
  { href: "#booking", label: "Rendez-vous" },
];

export function Nav() {
  const [solid, setSolid] = useState(false);

  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className={`nav ${solid ? "nav--solid" : ""}`}>
      <div className="container nav__row">
        <a href="#top" className="nav__mark" aria-label="LS Barber — accueil">
          LS
        </a>

        <nav className="nav__links" aria-label="Navigation principale">
          {LINKS.map((link) => (
            <a key={link.href} href={link.href} className="nav__link">
              {link.label}
            </a>
          ))}
        </nav>

        <div className="nav__actions">
          <a href={site.phoneHref} className="nav__phone">
            {site.phoneDisplay}
          </a>
          <a href={site.bookingUrl || site.phoneHref} className="btn btn-solid nav__cta">
            Réserver
          </a>
        </div>
      </div>
    </header>
  );
}
