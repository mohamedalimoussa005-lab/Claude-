import { useEffect, useState } from "react";
import { DESKTOP_QUERY } from "./gsap";

/** True for pointer-fine, wide viewports — the only place we run mouse parallax. */
export function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    setIsDesktop(mq.matches);
    const listener = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, []);

  return isDesktop;
}
