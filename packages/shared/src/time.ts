import type { Reservation } from "./types";

export const DEFAULT_RESERVATION_TTL_MINUTES = 15;

type Env = Record<string, string | undefined>;

export type TtlSource = "RESERVATION_TTL_SECONDS" | "RESERVATION_TTL_MINUTES" | "default";

export interface TtlResolution {
  ttlMs: number;
  /** Zmienna, z której wziął się efektywny TTL. */
  source: TtlSource;
  /** true, gdy ustawione są obie zmienne, a `RESERVATION_TTL_MINUTES` została zignorowana. */
  conflict: boolean;
}

function positive(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Efektywny TTL razem ze źródłem — do logu startowego i ostrzeżeń.
 * Pierwszeństwo: `RESERVATION_TTL_SECONDS` > `RESERVATION_TTL_MINUTES` > 15 min.
 */
export function resolveTtlFromEnv(env: Env = process.env): TtlResolution {
  const seconds = positive(env.RESERVATION_TTL_SECONDS);
  const minutes = positive(env.RESERVATION_TTL_MINUTES);

  if (seconds !== null) {
    return {
      ttlMs: Math.round(seconds * 1000),
      source: "RESERVATION_TTL_SECONDS",
      conflict: minutes !== null,
    };
  }
  if (minutes !== null) {
    return { ttlMs: Math.round(minutes * 60_000), source: "RESERVATION_TTL_MINUTES", conflict: false };
  }
  return { ttlMs: DEFAULT_RESERVATION_TTL_MINUTES * 60_000, source: "default", conflict: false };
}

/**
 * Jedno źródło TTL dla API, UI i testów.
 * `RESERVATION_TTL_SECONDS` istnieje po to, żeby demo wygaśnięcia nie trwało 15 minut.
 */
export function ttlMsFromEnv(env: Env = process.env): number {
  return resolveTtlFromEnv(env).ttlMs;
}

export function isReservationActive(
  reservation: Pick<Reservation, "status" | "expiresAt">,
  now: number = Date.now(),
): boolean {
  return (
    reservation.status === "active" &&
    Number.isFinite(new Date(reservation.expiresAt).getTime()) &&
    new Date(reservation.expiresAt).getTime() > now
  );
}

/** mm:ss do 60 minut, potem h:mm:ss. Wartości ujemne są przycinane do zera. */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);

  const tail = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${tail}` : tail;
}

export function formatCountdownLabel(remainingMs: number): string {
  if (remainingMs <= 0) return "Rezerwacja wygasła";
  const seconds = Math.ceil(remainingMs / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} min`;
}
