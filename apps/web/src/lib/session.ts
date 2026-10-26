import type { ReservationView, Ticket } from "@pas/shared";

const RESERVATION_PREFIX = "pas.reservation.";
const TICKET_PREFIX = "pas.ticket.";
const PASSENGER_KEY = "pas.passenger";

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
    // Tryb prywatny może odmówić zapisu; URL nadal niesie ID.
  }
}

export function saveReservation(view: ReservationView): void {
  write(`${RESERVATION_PREFIX}${view.reservationId}`, view);
}

export function loadReservation(reservationId: string): ReservationView | null {
  return read<ReservationView>(`${RESERVATION_PREFIX}${reservationId}`);
}

export function saveTicket(ticket: Ticket): void {
  write(`${TICKET_PREFIX}${ticket.reservationId}`, ticket);
}

export function loadTicket(reservationId: string): Ticket | null {
  return read<Ticket>(`${TICKET_PREFIX}${reservationId}`);
}

export interface PassengerDraft {
  customerName: string;
  email: string;
}

export function savePassenger(passenger: PassengerDraft): void {
  try {
    window.localStorage.setItem(PASSENGER_KEY, JSON.stringify(passenger));
  } catch {
    // Bez zapisu — formularz i tak działa.
  }
}

export function loadPassenger(): PassengerDraft {
  try {
    const raw = window.localStorage.getItem(PASSENGER_KEY);
    if (!raw) return { customerName: "", email: "" };
    const parsed = JSON.parse(raw) as Partial<PassengerDraft>;
    return {
      customerName: typeof parsed.customerName === "string" ? parsed.customerName : "",
      email: typeof parsed.email === "string" ? parsed.email : "",
    };
  } catch {
    return { customerName: "", email: "" };
  }
}
