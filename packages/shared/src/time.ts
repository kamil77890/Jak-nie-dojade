import type { Reservation } from "./types";

export const DEFAULT_RESERVATION_TTL_MINUTES = 15;

type Env = Record<string, string | undefined>;

/**
 * Jedno źródło TTL dla API, UI i testów.
 * `RESERVATION_TTL_SECONDS` istnieje po to, żeby demo wygaśnięcia nie trwało 15 minut.
 */
export function ttlMsFromEnv(env: Env = process.env): number {
  const seconds = Number(env.RESERVATION_TTL_SECONDS);
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);

  const minutes = Number(env.RESERVATION_TTL_MINUTES);
  if (Number.isFinite(minutes) && minutes > 0) return Math.round(minutes * 60_000);

  return DEFAULT_RESERVATION_TTL_MINUTES * 60_000;
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
