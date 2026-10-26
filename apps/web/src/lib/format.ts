import type { Event, EventSummary } from "@pas/shared";

export function trainLabel(eventId: string): string {
  const [operator, number] = eventId.split("-");
  if (!operator || !number) return "Pociąg";
  return `${operator.toUpperCase()} ${number}`;
}

/** "Warszawa Wschodnia → Kraków Główny" → stacja początkowa i docelowa. */
export function splitRelation(relation: string): { from: string; to: string } {
  const [from = relation, to = ""] = relation.split(/\s*→\s*/);
  return { from, to };
}

export function weekdayPl(isoDate: string): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  return new Intl.DateTimeFormat("pl-PL", { weekday: "long", timeZone: "UTC" }).format(date);
}

export function timeFromIso(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pl-PL", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Warsaw",
  }).format(date);
}

export function toSummary(event: Event): EventSummary {
  const { wagons, ...summary } = event;
  void wagons;
  return summary;
}

export function seatsInWagonLabel(count: number): string {
  if (count === 1) return "1 miejsce";
  const lastDigit = count % 10;
  const lastTwo = count % 100;
  if (lastDigit >= 2 && lastDigit <= 4 && (lastTwo < 12 || lastTwo > 14)) return `${count} miejsca`;
  return `${count} miejsc`;
}

/** Odmiana bez liczby: "wolne miejsce", "wolne miejsca", "wolnych miejsc". */
export function freeSeatsWord(count: number): string {
  if (count === 1) return "wolne miejsce";
  const lastDigit = count % 10;
  const lastTwo = count % 100;
  if (lastDigit >= 2 && lastDigit <= 4 && (lastTwo < 12 || lastTwo > 14)) return "wolne miejsca";
  return "wolnych miejsc";
}
