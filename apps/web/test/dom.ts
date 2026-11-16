import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

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

/** Node 26 nie daje `localStorage` bez flagi, a jsdom bywa go pozbawiony. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, String(value));
    },
  } as Storage;
}

export function installDom(): void {
  beforeEach(() => {
    if (!window.localStorage) {
      Object.defineProperty(window, "localStorage", {
        value: memoryStorage(),
        configurable: true,
        writable: true,
      });
    }
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    // Czyszczenie PRZED unstubAllGlobals: inaczej storage znika razem ze stubem.
    try {
      window.sessionStorage?.clear();
      window.localStorage?.clear();
    } catch {
      // Brak storage w danym środowisku nie może wywracać testu.
    }
    vi.unstubAllGlobals();
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
