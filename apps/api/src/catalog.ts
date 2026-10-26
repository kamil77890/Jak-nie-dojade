import {
  EVENTS,
  EVENT_SUMMARIES,
  type Event,
  type EventSummary,
  type Seat,
} from "@pas/shared";

/** Kursy są niezmienne w Etapie I, więc trzymamy je w fixtures, nie w bazie. */
export class EventCatalog {
  list(): EventSummary[] {
    return EVENT_SUMMARIES;
  }

  getEvent(eventId: string): Event | undefined {
    return EVENTS.find((event) => event.id === eventId);
  }

  getSeat(eventId: string, seatId: string): Seat | undefined {
    return this.getEvent(eventId)
      ?.wagons.flatMap((wagon) => wagon.seats)
      .find((seat) => seat.id === seatId);
  }
}
