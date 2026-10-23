import { useEffect, useSyncExternalStore } from 'react';

// The page's motion (DESIGN.md, "Landing page"): scroll reveals and the hero demo's loop. Everything is visible by default; motion only starts once the script runs,
// and never under prefers-reduced-motion.

const REDUCED = '(prefers-reduced-motion: reduce)';

/** True when the visitor asked for less motion, or when the browser can't tell us. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia(REDUCED).matches;
}

function subscribeReduced(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(REDUCED);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** prefers-reduced-motion, live. The prerendered HTML assumes reduced (the final state). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, prefersReducedMotion, () => true);
}

/**
 * Reveals every `[data-reveal]` element once, as it scrolls into view: CSS hides them only
 * while `<html data-motion>` is set, so without the script (or with reduced motion) they're
 * simply there. What's already on screen is marked shown first, so nothing flickers.
 */
export function useScrollReveal(): void {
  useEffect(() => {
    if (prefersReducedMotion() || typeof IntersectionObserver === 'undefined') return;
    const root = document.documentElement;
    const show = (el: Element) => el.setAttribute('data-shown', '');
    const waiting: Element[] = [];
    for (const el of document.querySelectorAll('[data-reveal]:not([data-shown])')) {
      if (el.getBoundingClientRect().top < window.innerHeight) show(el);
      else waiting.push(el);
    }
    root.dataset.motion = '';

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        show(entry.target);
        observer.unobserve(entry.target);
      }
    });
    waiting.forEach((el) => observer.observe(el));
    return () => {
      observer.disconnect();
      delete root.dataset.motion;
    };
  }, []);
}
