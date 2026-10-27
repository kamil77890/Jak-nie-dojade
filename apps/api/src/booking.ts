import { randomInt, randomUUID } from "node:crypto";
import {
  isReservationActive,
  type CreateReservationInput,
  type PaymentStatus,
  type Reservation,
  type ReservationStatusResponse,
} from "@pas/shared";
import type { EventCatalog } from "./catalog";
import { type Db, transaction } from "./db";
import {
  EventOrSeatNotFoundError,
  PaymentRequiredError,
  ReservationExpiredError,
  ReservationNotFoundError,
  ReservationPaidError,
  SeatUnavailableError,
} from "./errors";
import type { JobQueue } from "./jobs";

interface ReservationRow {
  id: string;
  event_id: string;
  seat_id: string;
  customer_name: string;
  email: string;
  created_at: string;
  expires_at: string;
  status: Reservation["status"];
  code: string | null;
  amount: number;
  paid_session_id: string | null;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface PurchaseResult {
  code: string;
  reservation: Reservation;
  duplicate: boolean;
}

/** Płatność z webhooka. `paidAt` to czas zdarzenia u Stripe'a, nie chwila dostarczenia. */
export interface PaymentConfirmation {
  reservationId: string;
  sessionId: string;
  amount: number;
  currency: string;
  paidAt: number;
}

/**
 * Wynik zaksięgowania płatności. `refund` znaczy, że pieniądze przyszły,
 * ale biletu nie wydamy — trzeba je oddać.
 */
export type PaymentOutcome =
  | { kind: "paid"; code: string }
  | { kind: "duplicate"; code: string }
  | {
      kind: "refund";
      reason: "unknown_reservation" | "already_paid" | "amount_mismatch" | "late_payment" | "seat_taken";
    };

const CLIENT_STATUS: Record<Reservation["status"], PaymentStatus> = {
  active: "held",
  purchased: "paid",
  expired: "expired",
};

export interface ReservationStats {
  active: number;
  purchased: number;
  expired: number;
  total: number;
}

export class BookingService {
  constructor(
    private readonly db: Db,
    private readonly catalog: EventCatalog,
    private readonly jobs: JobQueue,
    private readonly ttlMs: number,
    private readonly clock: () => number,
  ) {}

  /**
   * Każde drugie zajęcie miejsca z ważną rezerwacją albo kupionego daje 409 —
   * także powtórka identycznego requestu (karta B: „drugie zajęcie … daje 409”).
   */
  createReservation(input: CreateReservationInput): Reservation {
    const event = this.catalog.getEvent(input.eventId);
    if (!event || !this.catalog.getSeat(input.eventId, input.seatId)) {
      throw new EventOrSeatNotFoundError();
    }
    // Cena zamrożona w chwili rezerwacji: zmiana cennika nie ruszy już tej kwoty.
    const amount = event.price;

    const now = this.clock();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + this.ttlMs).toISOString();
    const id = randomUUID();

    return transaction(this.db, () => {
      this.expireStale(createdAt);

      const taken = this.db
        .prepare(
          `SELECT 1 FROM reservations
           WHERE event_id = ? AND seat_id = ? AND status IN ('active', 'purchased')
           LIMIT 1`,
        )
        .get(input.eventId, input.seatId);

      if (taken) throw new SeatUnavailableError();

      try {
        this.db
          .prepare(
            `INSERT INTO reservations
               (id, event_id, seat_id, customer_name, email, created_at, expires_at, status, code, purchased_at, amount)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?)`,
          )
          .run(
            id,
            input.eventId,
            input.seatId,
            input.customerName,
            input.email,
            createdAt,
            expiresAt,
            amount,
          );
      } catch (error) {
        // Unique index na (event_id, seat_id) jest ostatnią linią obrony.
        if (String(error).includes("UNIQUE constraint failed")) throw new SeatUnavailableError();
        throw error;
      }

      return {
        id,
        eventId: input.eventId,
        seatId: input.seatId,
        customerName: input.customerName,
        email: input.email,
        createdAt,
        expiresAt,
        status: "active",
        amount,
      };
    });
  }

  /**
   * Etap I: `POST /purchase` wydawał bilet bez płatności. Od Etapu II bilet wydaje
   * tylko webhook Stripe'a. Endpoint zostaje dla zgodności: opłacona rezerwacja
   * zwraca ten sam kod (idempotencja), nieopłacona dostaje 402.
   */
  purchase(reservationId: string): PurchaseResult {
    const nowIso = new Date(this.clock()).toISOString();

    return transaction(this.db, () => {
      this.expireStale(nowIso);

      const row = this.getRow(reservationId);
      if (!row) throw new ReservationNotFoundError();
      if (row.status === "purchased" && row.code) {
        return { code: row.code, reservation: this.mapRow(row), duplicate: true };
      }
      if (row.status === "expired") throw new ReservationExpiredError();
      throw new PaymentRequiredError();
    });
  }

  /** Sprawdza, czy rezerwację można teraz opłacić. Zwraca ją, jeśli tak. */
  assertPayable(reservationId: string): Reservation {
    const nowIso = new Date(this.clock()).toISOString();

    return transaction(this.db, () => {
      this.expireStale(nowIso);

      const row = this.getRow(reservationId);
      if (!row) throw new ReservationNotFoundError();
      if (row.status === "purchased") throw new ReservationPaidError();
      if (row.status === "expired") throw new ReservationExpiredError();
      return this.mapRow(row);
    });
  }

  /** `GET /api/reservations/:id` — stan widziany przez klienta po powrocie ze Stripe'a. */
  getStatus(reservationId: string): ReservationStatusResponse {
    const nowIso = new Date(this.clock()).toISOString();

    return transaction(this.db, () => {
      this.expireStale(nowIso);

      const row = this.getRow(reservationId);
      if (!row) throw new ReservationNotFoundError();
      return {
        status: CLIENT_STATUS[row.status],
        amount: row.amount,
        expiresAt: row.expires_at,
        ...(row.status === "purchased" && row.code ? { code: row.code } : {}),
      };
    });
  }

  /**
   * Księguje płatność z webhooka w jednej transakcji: status, kod biletu i job e-mail.
   * O tym, czy klient zdążył, decyduje czas płatności u Stripe'a. Webhook może
   * dojść po `expiresAt`, choć klient zapłacił przed nim — wtedy bilet się należy,
   * o ile nikt w międzyczasie nie zajął miejsca.
   */
  confirmPayment(payment: PaymentConfirmation): PaymentOutcome {
    const now = this.clock();
    const nowIso = new Date(now).toISOString();

    return transaction(this.db, () => {
      this.expireStale(nowIso);

      const row = this.getRow(payment.reservationId);
      if (!row) return { kind: "refund", reason: "unknown_reservation" };

      if (row.status === "purchased" && row.code) {
        // Ta sama sesja drugi raz to powtórka. Inna sesja to druga zapłata za to samo miejsce.
        return row.paid_session_id === payment.sessionId
          ? { kind: "duplicate", code: row.code }
          : { kind: "refund", reason: "already_paid" };
      }

      if (payment.amount !== row.amount || payment.currency.toLowerCase() !== "pln") {
        return { kind: "refund", reason: "amount_mismatch" };
      }

      if (payment.paidAt >= Date.parse(row.expires_at)) {
        return { kind: "refund", reason: "late_payment" };
      }

      const code = this.generateCode();
      try {
        this.db
          .prepare(
            `UPDATE reservations
             SET status = 'purchased', code = ?, purchased_at = ?, paid_session_id = ?
             WHERE id = ? AND status IN ('active', 'expired')`,
          )
          .run(code, nowIso, payment.sessionId, payment.reservationId);
      } catch (error) {
        // Rezerwacja wygasła leniwie, a ktoś w tym czasie zajął miejsce.
        if (String(error).includes("UNIQUE constraint failed")) {
          return { kind: "refund", reason: "seat_taken" };
        }
        throw error;
      }

      this.jobs.enqueue("send-ticket-email", { reservationId: payment.reservationId }, { now });
      return { kind: "paid", code };
    });
  }

  getReservation(reservationId: string): Reservation | null {
    const row = this.getRow(reservationId);
    return row ? this.mapRow(row) : null;
  }

  takenSeats(eventId: string): string[] {
    const nowIso = new Date(this.clock()).toISOString();
    return transaction(this.db, () => {
      this.expireStale(nowIso);
      const rows = this.db
        .prepare(
          `SELECT seat_id FROM reservations
           WHERE event_id = ? AND status IN ('active', 'purchased')
           ORDER BY seat_id`,
        )
        .all(eventId) as unknown as Array<{ seat_id: string }>;
      return rows.map((row) => row.seat_id);
    });
  }

  stats(): ReservationStats {
    const nowIso = new Date(this.clock()).toISOString();
    return transaction(this.db, () => {
      this.expireStale(nowIso);
      const row = this.db
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active,
             COALESCE(SUM(CASE WHEN status = 'purchased' THEN 1 ELSE 0 END), 0) AS purchased,
             COALESCE(SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END), 0) AS expired,
             COUNT(*) AS total
           FROM reservations`,
        )
        .get() as unknown as ReservationStats;

      return {
        active: Number(row.active),
        purchased: Number(row.purchased),
        expired: Number(row.expired),
        total: Number(row.total),
      };
    });
  }

  /** Leniwe wygaszanie: bez crona, każdy odczyt i zakup sprawdza czas. */
  private expireStale(nowIso: string): void {
    this.db
      .prepare(
        `UPDATE reservations
         SET status = 'expired'
         WHERE status = 'active' AND expires_at <= ?`,
      )
      .run(nowIso);
  }

  private getRow(id: string): ReservationRow | null {
    const row = this.db
      .prepare("SELECT * FROM reservations WHERE id = ?")
      .get(id) as unknown as ReservationRow | undefined;
    return row ?? null;
  }

  private mapRow(row: ReservationRow): Reservation {
    return {
      id: row.id,
      eventId: row.event_id,
      seatId: row.seat_id,
      customerName: row.customer_name,
      email: row.email,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      status: row.status,
      amount: row.amount,
      ...(row.code ? { code: row.code } : {}),
    };
  }

  private generateCode(): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      let suffix = "";
      for (let index = 0; index < 6; index += 1) {
        suffix += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
      }
      const code = `PAS-${suffix}`;
      const exists = this.db.prepare("SELECT 1 FROM reservations WHERE code = ?").get(code);
      if (!exists) return code;
    }
    throw new Error("Nie udało się wygenerować unikalnego kodu biletu.");
  }
}
