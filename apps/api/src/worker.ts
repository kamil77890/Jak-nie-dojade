import {
  formatEventDate,
  formatSeatLabel,
  type Reservation,
} from "@pas/shared";
import type { BookingService } from "./booking";
import type { EventCatalog } from "./catalog";
import type { AppConfig } from "./config";
import type { JobQueue, JobRecord } from "./jobs";
import { MailDeliveryError, type Mailer, type TicketMail } from "./mail";
import { CircuitBreaker, CircuitOpenError, withRetry } from "./resilience";

interface WorkerDependencies {
  queue: JobQueue;
  bookings: BookingService;
  catalog: EventCatalog;
  mailer: Mailer;
  breaker: CircuitBreaker;
  config: AppConfig;
  clock: () => number;
}

export interface WorkerSnapshot {
  enabled: boolean;
  lastRunAt: string | null;
  processed: number;
  failed: number;
  dlq: number;
  lastError: string | null;
}

/**
 * Worker kolejki: claim → praca → ack. Ack jest po wysyłce, więc job
 * nie zginie. Powtórka jest bezpieczna, bo dostawca dostaje ten sam
 * Idempotency-Key (job.id).
 */
export class TicketMailWorker {
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  private lastRunAt: string | null = null;
  private processed = 0;
  private failed = 0;
  private dlq = 0;
  private lastError: string | null = null;

  constructor(private readonly dependencies: WorkerDependencies) {}

  start(): void {
    if (this.timer || !this.dependencies.config.worker.enabled) return;

    this.timer = setInterval(() => {
      void this.tick();
    }, this.dependencies.config.worker.intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.current;
  }

  /** Jedno przejście pętli — używane też bezpośrednio w testach. */
  async runOnce(): Promise<boolean> {
    const { queue, config } = this.dependencies;
    const job = queue.claim(config.worker.leaseMs);
    if (!job) return false;

    this.lastRunAt = new Date(this.dependencies.clock()).toISOString();

    try {
      if (job.task !== "send-ticket-email") {
        throw new UnsupportedJobError(`Nieznane zadanie: ${job.task}`);
      }
      const message = this.compose(job);
      await withRetry(
        () => this.dependencies.breaker.fire(() => this.dependencies.mailer.send(message, job.id)),
        {
          attempts: config.mail.retryAttempts,
          baseDelayMs: config.mail.retryBaseDelayMs,
          shouldRetry: (error) =>
            !(error instanceof CircuitOpenError) &&
            (!(error instanceof MailDeliveryError) || error.retryable),
          onRetry: (error) => {
            this.lastError = error instanceof Error ? error.message : String(error);
          },
        },
      );

      queue.ack(job.id);
      this.processed += 1;
      return true;
    } catch (error) {
      const permanent =
        error instanceof MailDeliveryError && !error.retryable
          ? true
          : error instanceof MissingReservationError || error instanceof UnsupportedJobError;
      const result = queue.fail(job.id, error, {
        maxAttempts: config.worker.maxAttempts,
        baseBackoffMs: config.worker.baseBackoffMs,
        maxBackoffMs: config.worker.maxBackoffMs,
        permanent,
      });

      this.failed += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
      if (result === "dlq") this.dlq += 1;
      return true;
    }
  }

  snapshot(): WorkerSnapshot {
    return {
      enabled: this.dependencies.config.worker.enabled,
      lastRunAt: this.lastRunAt,
      processed: this.processed,
      failed: this.failed,
      dlq: this.dlq,
      lastError: this.lastError,
    };
  }

  private compose(job: JobRecord): TicketMail {
    const reservationId =
      typeof job.input.reservationId === "string" ? job.input.reservationId : "";
    if (!reservationId) throw new MissingReservationError("Job bez reservationId.");

    const reservation = this.dependencies.bookings.getReservation(reservationId);
    if (!reservation) throw new MissingReservationError("Rezerwacja z joba już nie istnieje.");
    if (!reservation.code) throw new MissingReservationError("Rezerwacja nie ma jeszcze kodu biletu.");

    const event = this.dependencies.catalog.getEvent(reservation.eventId);
    if (!event) throw new MissingReservationError("Kurs z rezerwacji już nie istnieje.");

    return buildTicketMail(reservation, {
      relation: event.relation,
      date: formatEventDate(event.date),
      departureTime: event.departureTime,
      seatLabel: formatSeatLabel(reservation.seatId),
    });
  }

  private async tick(): Promise<void> {
    if (this.current) return;

    this.current = this.drain().finally(() => {
      this.current = null;
    });
    await this.current;
  }

  private async drain(): Promise<void> {
    for (let processed = 0; processed < 20; processed += 1) {
      const hadJob = await this.runOnce();
      if (!hadJob) return;
    }
  }
}

class MissingReservationError extends Error {}

class UnsupportedJobError extends Error {}

export function buildTicketMail(
  reservation: Reservation,
  details: {
    relation: string;
    date: string;
    departureTime: string;
    seatLabel: string;
  },
): TicketMail {
  return {
    to: reservation.email,
    reservationId: reservation.id,
    subject: `Twój bilet ${reservation.code} — ${details.relation}`,
    text: [
      `Dzień dobry, ${reservation.customerName}!`,
      "",
      "Dziękujemy za płatność — Twój bilet jest gotowy.",
      "",
      `Kurs: ${details.relation}`,
      `Data: ${details.date}`,
      `Odjazd: ${details.departureTime}`,
      `Miejsce: ${details.seatLabel}`,
      `Kod biletu: ${reservation.code}`,
      "",
      "Bilet jest ważny niezależnie od tego, czy e-mail dotrze od razu — potwierdzenie wysyłamy w tle.",
      "",
      "Do zobaczenia na peronie!",
      "PAS / Kasa biletowa",
    ].join("\n"),
  };
}
