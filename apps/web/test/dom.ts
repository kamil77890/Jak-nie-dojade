import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

/**
 * jsdom nie ma matchMedia ani scrollTo, a GSAP sięga po nie już przy imporcie,
 * więc ten moduł importuj przed `App`. `matches: true` włącza też
 * prefers-reduced-motion, więc animacje GSAP i Lenis nie startują w testach.
 */
window.matchMedia = ((query: string) => ({
  matches: true,
  media: query,
  onchange: null,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => false,
})) as typeof window.matchMedia;
window.scrollTo = (() => undefined) as typeof window.scrollTo;

export function installDom(): void {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
    window.localStorage.clear();
  });
}

/** Przesuwa tylko `Date` — interwał licznika (250 ms) i waitFor chodzą na prawdziwym czasie. */
export function freezeDate(now: number): (ms: number) => void {
  vi.useFakeTimers({ toFake: ["Date"], now });
  let current = now;
  return (ms: number) => {
    current += ms;
    vi.setSystemTime(current);
  };
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Wartość pola biletu: <dt>Wagon</dt><dd>5</dd> → "5". */
export function ticketField(ticket: HTMLElement, label: string): string {
  const term = Array.from(ticket.querySelectorAll("dt")).find((dt) => dt.textContent === label);
  return term?.nextElementSibling?.textContent?.trim() ?? "";
}
