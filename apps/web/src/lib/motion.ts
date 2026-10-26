import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { type DependencyList, type RefObject, useLayoutEffect } from "react";

gsap.registerPlugin(ScrollTrigger);

/** Wspólny easing całej strony — ten sam, co w CSS (--ease-out-expo). */
export const EASE = "expo.out";

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

let lenis: Lenis | null = null;

/**
 * Płynne przewijanie. Lenis i ScrollTrigger muszą chodzić na jednym zegarze,
 * inaczej animacje przypięte do scrolla drgają o klatkę.
 */
export function startSmoothScroll(): void {
  if (lenis || prefersReducedMotion()) return;
  lenis = new Lenis({ lerp: 0.11, wheelMultiplier: 1 });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((time) => lenis?.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
}

export function scrollToTop(): void {
  if (lenis) lenis.scrollTo(0, { immediate: true });
  else window.scrollTo({ top: 0, behavior: "instant" });
}

export function scrollToTarget(target: string | HTMLElement): void {
  if (lenis) {
    lenis.scrollTo(target, { offset: -72, duration: 1.4 });
    return;
  }
  const element = typeof target === "string" ? document.querySelector(target) : target;
  element?.scrollIntoView({ behavior: "smooth" });
}

/**
 * Animacje GSAP w zakresie jednego komponentu. Kontekst sprząta wszystkie
 * tweeny i ScrollTriggery przy odmontowaniu, więc nic nie wisi po zmianie trasy.
 */
export function useGsap(
  scope: RefObject<HTMLElement | null>,
  effect: () => void,
  deps: DependencyList,
): void {
  useLayoutEffect(() => {
    if (!scope.current || prefersReducedMotion()) return;
    const context = gsap.context(effect, scope.current);
    return () => context.revert();
  }, deps);
}

/** Elementy z [data-reveal] wypływają z dołu, gdy wjeżdżają w kadr. */
export function revealOnScroll(selector = "[data-reveal]"): void {
  gsap.utils.toArray<HTMLElement>(selector).forEach((element) => {
    gsap.from(element, {
      y: 48,
      opacity: 0,
      duration: 1.2,
      ease: EASE,
      delay: Number(element.dataset.revealDelay ?? 0),
      scrollTrigger: { trigger: element, start: "top 88%" },
    });
  });
}

export { gsap, ScrollTrigger };

const SCRAMBLE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Tekst „losuje się” znak po znaku i zatrzymuje na docelowym, od lewej do prawej. */
export function scrambleText(element: HTMLElement, target: string, frames = 24): void {
  let frame = 0;
  const timer = window.setInterval(() => {
    frame += 1;
    const settled = Math.floor((frame / frames) * target.length);
    element.textContent = target
      .split("")
      .map((char, index) =>
        index < settled || char === "-"
          ? char
          : SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)],
      )
      .join("");
    if (frame >= frames) {
      element.textContent = target;
      window.clearInterval(timer);
    }
  }, 42);
}
