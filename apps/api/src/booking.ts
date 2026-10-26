import { randomInt, randomUUID } from "node:crypto";
import { isReservationActive, type CreateReservationInput, type Reservation } from "@pas/shared";
import type { EventCatalog } from "./catalog";
import { type Db, transaction } from "./db";
import {
  EventOrSeatNotFoundError,
  ReservationExpiredError,
  ReservationNotFoundError,
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
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface PurchaseResult {
  code: string;
  reservation: Reservation;
  duplicate: boolean;
}

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
    if (!this.catalog.getEvent(input.eventId) || !this.catalog.getSeat(input.eventId, input.seatId)) {
      throw new EventOrSeatNotFoundError();
    }

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
               (id, event_id, seat_id, customer_name, email, created_at, expires_at, status, code, purchased_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL)`,
          )
          .run(
            id,
            input.eventId,
            input.seatId,
            input.customerName,
            input.email,
            createdAt,
            expiresAt,
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
      };
    });
  }

  /**
   * Zakup jest idempotentny: drugi request zwraca ten sam kod i nie tworzy
   * drugiego joba. Job e-mail powstaje w tej samej transakcji co zakup.
   */
  purchase(reservationId: string): PurchaseResult {
    const now = this.clock();
    const nowIso = new Date(now).toISOString();

    return transaction(this.db, () => {
      this.expireStale(nowIso);

      const row = this.getRow(reservationId);
      if (!row) throw new ReservationNotFoundError();

      if (row.status === "purchased" && row.code) {
        return { code: row.code, reservation: this.mapRow(row), duplicate: true };
      }

      const stillActive = isReservationActive(
        { status: "active", expiresAt: row.expires_at },
        now,
      );
      if (row.status !== "active" || !stillActive) {
        if (row.status === "active") {
          this.db
            .prepare("UPDATE reservations SET status = 'expired' WHERE id = ?")
            .run(reservationId);
        }
        throw new ReservationExpiredError();
      }

      const code = this.generateCode();
      this.db
        .prepare(
          `UPDATE reservations
           SET status = 'purchased', code = ?, purchased_at = ?
           WHERE id = ? AND status = 'active'`,
        )
        .run(code, nowIso, reservationId);

      this.jobs.enqueue("send-ticket-email", { reservationId }, { now });

      return {
        code,
        reservation: { ...this.mapRow(row), status: "purchased", code },
        duplicate: false,
      };
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
