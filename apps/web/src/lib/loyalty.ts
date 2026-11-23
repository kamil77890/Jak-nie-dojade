import { ApiRequestError, getLoyalty } from "./api";

/**
 * Saldo punktów w przeglądarce. Voucherify (przez API) przyjmuje najwyżej 100 wywołań
 * na godzinę dla całej kasy, więc karta pyta o saldo oszczędnie:
 * - tylko o „skończony” e-mail (poprawny format, po wyjściu z pola — nie przy każdej literze),
 * - raz na e-mail: wynik pamiętamy w sessionStorage, a ekran płatności używa go ponownie,
 * - po 429/503 nie pytamy aż do Retry-After; brak salda nie blokuje płatności kartą.
 *
 * To tylko podpowiedź dla klienta — o tym, ile punktów da się wydać, decyduje serwer.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_EMAIL = 160;
const BALANCE_PREFIX = "pas.loyalty.";
const BLOCKED_KEY = "pas.loyalty-blocked-until";
/** Jak długo saldo w karcie jest aktualne. Serwer i tak trzyma je w krótkim cache. */
const FRESH_MS = 60_000;
/** 429/503 bez Retry-After — przerwa, zanim znów zapytamy. */
const DEFAULT_BLOCK_SECONDS = 30;
/**
 * Górna granica przerwy w karcie. Budżet Voucherify potrafi kazać czekać do godziny,
 * ale e-mail bez karty (1000 pkt) serwer obsłuży bez Voucherify — po 2 min warto spróbować.
 */
const MAX_BLOCK_SECONDS = 120;

interface StoredBalance {
  points: number;
  at: number;
}

const inFlight = new Map<string, Promise<number | null>>();

/** E-mail w postaci, w jakiej pyta serwer (trim, małe litery); null = niepoprawny. */
export function normalizeLoyaltyEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

/** Saldo już pobrane w tej karcie (bez requestu); null = nie znamy albo jest stare. */
export function peekLoyaltyBalance(raw: string): number | null {
  const email = normalizeLoyaltyEmail(raw);
  if (!email) return null;
  const stored = read<StoredBalance>(`${BALANCE_PREFIX}${email}`);
  if (!stored || typeof stored.points !== "number" || typeof stored.at !== "number") return null;
  return Date.now() - stored.at < FRESH_MS ? stored.points : null;
}

/** Po wydaniu punktów saldo w karcie jest nieaktualne. */
export function forgetLoyaltyBalance(raw: string): void {
  const email = normalizeLoyaltyEmail(raw);
  if (!email) return;
  try {
    window.sessionStorage.removeItem(`${BALANCE_PREFIX}${email}`);
  } catch {
    // Brak storage — nic do zapomnienia.
  }
}

/**
 * Saldo dla e-maila: z pamięci karty albo jednym requestem (równoległe wywołania
 * dla tego samego e-maila dzielą request). Zwraca null, gdy saldo jest niedostępne —
 * wtedy UI po prostu nie pokazuje punktów.
 */
export function loadLoyaltyBalance(raw: string): Promise<number | null> {
  const email = normalizeLoyaltyEmail(raw);
  if (!email) return Promise.resolve(null);

  const known = peekLoyaltyBalance(email);
  if (known !== null) return Promise.resolve(known);

  const blockedUntil = read<number>(BLOCKED_KEY);
  if (typeof blockedUntil === "number" && Date.now() < blockedUntil) return Promise.resolve(null);

  const pending = inFlight.get(email);
  if (pending) return pending;

  const request = getLoyalty(email)
    .then((result) => {
      write(`${BALANCE_PREFIX}${email}`, { points: result.points, at: Date.now() } satisfies StoredBalance);
      return result.points;
    })
    .catch((error: unknown) => {
      // 429 (limit per IP) i 503 (Voucherify/budżet): odczekaj Retry-After, nie dobijaj API.
      if (error instanceof ApiRequestError && (error.status === 429 || error.status === 503)) {
        const seconds = Math.min(MAX_BLOCK_SECONDS, error.retryAfter ?? DEFAULT_BLOCK_SECONDS);
        write(BLOCKED_KEY, Date.now() + seconds * 1000);
      }
      return null;
    })
    .finally(() => inFlight.delete(email));
  inFlight.set(email, request);
  return request;
}

function read<T>(key: string): T | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Tryb prywatny może odmówić zapisu — zapytamy ponownie, nic więcej.
  }
}
