import { useEffect, type RefObject } from "react";
import { animate } from "framer-motion";

/** Marketing-only accents; content remains visible before observation and without JS. */
export function useScrollReveals(
  page: RefObject<HTMLElement | null>,
  reduced: boolean,
) {
  useEffect(() => {
    if (reduced || !page.current || typeof IntersectionObserver === "undefined")
      return;
    const animations: ReturnType<typeof animate>[] = [];
    const elements = page.current.querySelectorAll<HTMLElement>(
      ".section .eyebrow, .section h2, .pillars > article, .team-grid > article",
    );
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const element = entry.target as HTMLElement;
          observer.unobserve(element);
          // Avoid delayed entrances when arriving directly at an anchor or tabbing to content.
          if (element.contains(document.activeElement)) continue;
          const card = element.matches("article");
          const index = card
            ? Array.from(element.parentElement!.children).indexOf(element)
            : 0;
          animations.push(
            animate(
              element,
              { opacity: [0, 1], y: [20, 0] },
              {
                duration: 0.5,
                delay: card ? (index % 3) * 0.07 : 0,
                ease: [0.22, 1, 0.36, 1],
              },
            ),
          );
        }
      },
      { threshold: 0.15 },
    );
    elements.forEach((element) => observer.observe(element));
    return () => {
      observer.disconnect();
      animations.forEach((animation) => animation.stop());
      elements.forEach((element) => {
        element.style.removeProperty("opacity");
        element.style.removeProperty("transform");
      });
    };
  }, [page, reduced]);
}
