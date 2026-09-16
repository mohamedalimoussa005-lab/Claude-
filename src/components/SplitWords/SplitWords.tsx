import "./SplitWords.css";

interface SplitWordsProps {
  text: string;
  as?: "h1" | "h2" | "h3" | "p" | "span";
  className?: string;
  wordClassName?: string;
}

/**
 * Wraps each word in a clipping span so callers can animate the inner
 * span's transform (translateY / rotate) without fighting overflow on the
 * outer word box. Kept as markup, not JS text-splitting, so it degrades
 * to plain readable text if a section's GSAP timeline never runs.
 */
export function SplitWords({ text, as = "span", className, wordClassName }: SplitWordsProps) {
  const Tag = as;
  const words = text.split(" ");

  return (
    <Tag className={`split-words ${className ?? ""}`}>
      {words.map((word, i) => (
        <span className="split-words__clip" key={`${word}-${i}`}>
          <span className={`split-words__word ${wordClassName ?? ""}`}>
            {word}
            {i < words.length - 1 ? " " : ""}
          </span>
        </span>
      ))}
    </Tag>
  );
}
