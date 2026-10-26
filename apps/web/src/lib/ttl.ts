import { DEFAULT_RESERVATION_TTL_MINUTES } from "@pas/shared";
import { useEffect, useState } from "react";

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "";
const DEFAULT_TTL_SECONDS = DEFAULT_RESERVATION_TTL_MINUTES * 60;

let pending: Promise<number> | null = null;

/**
 * Efektywny TTL z `/api/health`. W trybie testowym prowadzącego to 2 minuty,
 * więc UI nie może obiecywać na sztywno 15. Bez API zostaje wartość domyślna.
 */
function fetchTtlSeconds(): Promise<number> {
  pending ??= fetch(`${BASE_URL}/api/health`)
    .then((response) => (response.ok ? (response.json() as Promise<{ reservationTtlSeconds?: unknown }>) : null))
    .then((body) => {
      const seconds = Number(body?.reservationTtlSeconds);
      if (Number.isFinite(seconds) && seconds > 0) return seconds;
      pending = null;
      return DEFAULT_TTL_SECONDS;
    })
    .catch(() => {
      pending = null;
      return DEFAULT_TTL_SECONDS;
    });
  return pending;
}

export function useReservationTtl(): number {
  const [seconds, setSeconds] = useState(DEFAULT_TTL_SECONDS);

  useEffect(() => {
    let alive = true;
    void fetchTtlSeconds().then((value) => {
      if (alive) setSeconds(value);
    });
    return () => {
      alive = false;
    };
  }, []);

  return seconds;
}

function plural(count: number, one: string, few: string, many: string): string {
  if (count === 1) return one;
  const lastDigit = count % 10;
  const lastTwo = count % 100;
  return lastDigit >= 2 && lastDigit <= 4 && (lastTwo < 12 || lastTwo > 14) ? few : many;
}

/** 900 → { value: 15, unit: "minut" }, 120 → { 2, "minuty" }, 20 → { 20, "sekund" }. */
export function ttlParts(seconds: number): { value: number; unit: string } {
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return { value: minutes, unit: plural(minutes, "minutę", "minuty", "minut") };
  }
  return { value: seconds, unit: plural(seconds, "sekundę", "sekundy", "sekund") };
}

/** „15 minut”, „2 minuty”, „20 sekund” — po „na” i „przez”. */
export function formatTtl(seconds: number): string {
  const { value, unit } = ttlParts(seconds);
  return `${value} ${unit}`;
}
