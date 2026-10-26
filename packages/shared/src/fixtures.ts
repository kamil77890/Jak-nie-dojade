import type { Event, EventSummary, Seat, Wagon } from "./types";

const SEATS_PER_WAGON = 20;
const WAGON_NUMBERS = [5, 6] as const;

/**
 * Pozycja z numeru: 1 okno, 2 korytarz, 3 korytarz, 4 okno — i tak w każdym rzędzie.
 * Siatka wagonu to 5 rzędów × 4 miejsca.
 */
function seatPosition(number: number): Seat["position"] {
  const indexInRow = (number - 1) % 4;
  return indexInRow === 0 || indexInRow === 3 ? "window" : "aisle";
}

function buildWagon(wagonNumber: number): Wagon {
  const seats: Seat[] = Array.from({ length: SEATS_PER_WAGON }, (_, index) => {
    const number = index + 1;
    return {
      id: `${wagonNumber}-${number}`,
      number,
      position: seatPosition(number),
    };
  });

  return { id: String(wagonNumber), number: wagonNumber, seats };
}

function buildEvent(input: Omit<Event, "wagons">): Event {
  return {
    ...input,
    wagons: WAGON_NUMBERS.map(buildWagon),
  };
}

export const EVENTS: Event[] = [
  buildEvent({
    id: "ic-7310-2026-11-21",
    relation: "Warszawa Wschodnia → Kraków Główny",
    date: "2026-11-21",
    departureTime: "08:10",
    arrivalTime: "10:55",
  }),
  buildEvent({
    id: "ic-8312-2026-11-21",
    relation: "Gdańsk Główny → Poznań Główny",
    date: "2026-11-21",
    departureTime: "09:40",
    arrivalTime: "12:20",
  }),
  buildEvent({
    id: "tlk-4710-2026-11-22",
    relation: "Wrocław Główny → Zakopane",
    date: "2026-11-22",
    departureTime: "06:25",
    arrivalTime: "12:10",
  }),
];

export const EVENT_SUMMARIES: EventSummary[] = EVENTS.map(({ wagons: _wagons, ...summary }) => summary);

export const DEMO_WAGON_NUMBERS = WAGON_NUMBERS;
export const DEMO_SEATS_PER_WAGON = SEATS_PER_WAGON;
export const DEMO_SEAT_COUNT = EVENTS.length * WAGON_NUMBERS.length * SEATS_PER_WAGON;

export function getEventById(eventId: string): Event | undefined {
  return EVENTS.find((event) => event.id === eventId);
}

export function getSeat(eventId: string, seatId: string): Seat | undefined {
  return getEventById(eventId)
    ?.wagons.flatMap((wagon) => wagon.seats)
    .find((seat) => seat.id === seatId);
}
