import { useState } from "react";
import "./ArtPanel.css";

interface ArtPanelProps {
  /** filename inside /public/assets — see public/assets/README.md */
  src: string;
  alt: string;
  className?: string;
  /** visual tone of the placeholder shown until the real photo lands */
  tone?: "chair" | "detail" | "tools" | "action" | "interior" | "gallery";
}

/**
 * Renders a photo slot that is art-directed even when the photo doesn't
 * exist yet: a duotone gradient + grain stand in, and the moment a file
 * matching `src` is dropped into /public/assets it silently takes over.
 */
export function ArtPanel({ src, alt, className, tone = "interior" }: ArtPanelProps) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  return (
    <div className={`art-panel art-panel--${tone} ${className ?? ""}`} role="img" aria-label={alt}>
      <div className="art-panel__placeholder" aria-hidden="true">
        <span className="art-panel__mark">LS</span>
      </div>
      {!errored && (
        <img
          className="art-panel__img"
          src={`/assets/${src}`}
          alt={alt}
          loading="lazy"
          decoding="async"
          style={{ opacity: loaded ? 1 : 0 }}
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
        />
      )}
    </div>
  );
}
