import type { Event, EventSummary } from "@pas/shared";

const MONTHS_SHORT = [
  "sty",
  "lut",
  "mar",
  "kwi",
  "maj",
  "cze",
  "lip",
  "sie",
  "wrz",
  "paź",
  "lis",
  "gru",
] as const;

export function trainLabel(eventId: string): string {
  const [operator, number] = eventId.split("-");
  if (!operator || !number) return "Pociąg";
  return `${operator.toUpperCase()} ${number}`;
}

export function weekdayPl(isoDate: string): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  return new Intl.DateTimeFormat("pl-PL", { weekday: "long", timeZone: "UTC" }).format(date);
}

export function monthShortPl(isoDate: string): string {
  const month = Number(isoDate.slice(5, 7));
  return MONTHS_SHORT[month - 1] ?? "";
}

export function dayOfMonth(isoDate: string): string {
  return isoDate.slice(8, 10);
}

export function yearOfDate(isoDate: string): string {
  return isoDate.slice(0, 4);
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
  if (count >= 2 && count <= 4) return `${count} miejsca`;
  return `${count} miejsc`;
}
