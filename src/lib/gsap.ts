import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

// Single shared breakpoint so every section agrees on what "desktop" means
// for parallax/pin work — mobile always gets the lighter path.
export const DESKTOP_QUERY = "(min-width: 900px) and (pointer: fine)";

export { gsap, ScrollTrigger };
