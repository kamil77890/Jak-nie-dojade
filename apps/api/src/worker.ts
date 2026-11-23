import {
  formatEventDate,
  formatSeatLabel,
  type Reservation,
} from "@pas/shared";
import type { BookingService } from "./booking";
import type { EventCatalog } from "./catalog";
import type { AppConfig } from "./config";
import type { JobQueue, JobRecord } from "./jobs";
import { LoyaltyThrottledError, type LoyaltyService } from "./loyalty";
import { LoyaltyUnavailableError } from "./errors";
import { MailDeliveryError, type Mailer, type TicketMail } from "./mail";
import { CircuitBreaker, CircuitOpenError, withRetry } from "./resilience";

interface WorkerDependencies {
  queue: JobQueue;
  bookings: BookingService;
  catalog: EventCatalog;
  mailer: Mailer;
  breaker: CircuitBreaker;
  loyalty: LoyaltyService;
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
      let mailError: unknown = null;
      try {
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
      } catch (error) {
        mailError = error;
      }

      // Punkty naliczamy niezależnie od poczty: nawet trwały błąd adresu nie może
      // odebrać klientowi punktów. Gdy Voucherify padnie, job wróci z backoffem.
      await this.awardPoints(job);

      // Błąd maila zgłaszamy po naliczeniu punktów — kolejka zdecyduje o retry/DLQ.
      if (mailError) throw mailError;

      queue.ack(job.id);
      this.processed += 1;
      return true;
    } catch (error) {
      const permanent =
        error instanceof MailDeliveryError && !error.retryable
          ? true
          : error instanceof MissingReservationError || error instanceof UnsupportedJobError;
      // Wyczerpany budżet Voucherify albo 429: punkty czekają na limit (do godziny),
      // a nie lądują w DLQ po kilku szybkich próbach.
      const throttled =
        error instanceof LoyaltyUnavailableError && error.cause instanceof LoyaltyThrottledError;
      const result = queue.fail(job.id, error, {
        maxAttempts: config.worker.maxAttempts,
        baseBackoffMs: config.worker.baseBackoffMs,
        maxBackoffMs: config.worker.maxBackoffMs,
        permanent,
        ...(throttled ? { deferMs: (error.retryAfter ?? 60) * 1000 } : {}),
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

  /** Naliczanie punktów jest idempotentne: znacznik w bazie i ponowna próba joba. */
  private async awardPoints(job: JobRecord): Promise<void> {
    const reservationId =
      typeof job.input.reservationId === "string" ? job.input.reservationId : "";
    if (!reservationId) return;
    const pending = this.dependencies.bookings.pendingPointsAward(reservationId);
    if (!pending) return;
    await this.dependencies.loyalty.awardPoints(pending.email, pending.points);
    this.dependencies.bookings.markPointsAwarded(reservationId);
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

    const status = this.dependencies.bookings.getStatus(reservationId);

    return buildTicketMail(reservation, {
      relation: event.relation,
      date: formatEventDate(event.date),
      departureTime: event.departureTime,
      seatLabel: formatSeatLabel(reservation.seatId),
      pointsUsed: status.pointsUsed,
      // Job powstaje dopiero po opłaceniu, więc pole jest; `?? 0` tylko dla typu.
      pointsEarned: status.pointsEarned ?? 0,
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
    pointsUsed?: number;
    pointsEarned?: number;
  },
): TicketMail {
  const pointsUsed = details.pointsUsed ?? 0;
  const pointsEarned = details.pointsEarned ?? 0;
  const paidByCard = Math.max(0, reservation.amount - pointsUsed);
  const summary = [
    `Zapłacono kartą: ${formatPln(paidByCard)}`,
    `Zapłacono punktami: ${pointsUsed} pkt (${formatPln(pointsUsed)})`,
    `Punkty za ten zakup: ${pointsEarned} pkt`,
  ];

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
      "Podsumowanie zakupu:",
      ...summary,
      "",
      `Saldo punktów sprawdzisz na stronie biletu i w aplikacji.`,
      "",
      "Bilet jest ważny niezależnie od tego, czy e-mail dotrze od razu — potwierdzenie wysyłamy w tle.",
      "",
      "Do zobaczenia na peronie!",
      "PAS / Kasa biletowa",
    ].join("\n"),
  };
}

/** 1 punkt = 1 grosz; kwoty w mailu pokazujemy w złotych. */
function formatPln(grosze: number): string {
  return `${(grosze / 100).toFixed(2).replace(".", ",")} zł`;
}
