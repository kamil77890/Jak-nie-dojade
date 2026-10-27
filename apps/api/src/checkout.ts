import type { CheckoutResponse } from "@pas/shared";
import { formatEventDate, formatSeatLabel } from "@pas/shared";
import type { BookingService, PaymentOutcome } from "./booking";
import type { EventCatalog } from "./catalog";
import { type Db, transaction } from "./db";
import { InvalidSignatureError, PaymentsUnavailableError } from "./errors";
import {
  InvalidWebhookSignatureError,
  type PaymentGateway,
  type PaymentWebhookEvent,
} from "./payments";
import type { CircuitBreaker } from "./resilience";

/** Nagłówek Idempotency-Key: 8–100 znaków, bez spacji i znaków sterujących. */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

export function isValidIdempotencyKey(key: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(key);
}

/** Stripe nie przyjmie sesji krótszej niż 30 min; doliczamy zapas na drogę requestu. */
const MIN_STRIPE_SESSION_MS = 31 * 60_000;

interface CheckoutSessionRow {
  id: string;
  url: string;
  expires_at: string;
}

export interface CheckoutServiceOptions {
  db: Db;
  bookings: BookingService;
  catalog: EventCatalog;
  /** null = Stripe nie jest skonfigurowany; checkout i webhook odpowiadają 503. */
  gateway: PaymentGateway | null;
  breaker: CircuitBreaker;
  /** Adres frontendu, na który Stripe odsyła klienta, np. https://kasa.example.com. */
  publicUrl: string;
  clock: () => number;
}

export interface WebhookResult {
  eventId: string;
  type: string;
  duplicate: boolean;
  outcome?: PaymentOutcome;
  refunded?: boolean;
}

/**
 * Karta A (sesja Checkout) i karta B (webhook). Każde wywołanie Stripe'a niesie
 * Idempotency-Key, a każde zdarzenie webhooka jest księgowane dokładnie raz.
 */
export class CheckoutService {
  /** Jedna sesja naraz na rezerwację — dwa kliknięcia w dwóch kartach nie dadzą dwóch płatności. */
  private readonly pending = new Map<string, Promise<CheckoutResponse>>();

  constructor(private readonly options: CheckoutServiceOptions) {}

  get enabled(): boolean {
    return this.options.gateway !== null;
  }

  async startCheckout(reservationId: string, idempotencyKey: string): Promise<CheckoutResponse> {
    const { gateway, bookings } = this.options;
    if (!gateway) throw new PaymentsUnavailableError();

    // 404 / 409 RESERVATION_EXPIRED / 409 RESERVATION_PAID — zanim zawołamy Stripe'a.
    const reservation = bookings.assertPayable(reservationId);

    // Powtórka z tym samym kluczem: ta sama sesja, bez drugiego wywołania Stripe'a.
    const sameKey = this.findByKey(reservationId, idempotencyKey);
    if (sameKey) return { url: sameKey.url };

    // Ponowna próba po przerwaniu: wciąż otwarta sesja zamiast drugiej,
    // którą klient mógłby opłacić równolegle.
    const open = this.findOpen(reservationId);
    if (open) return { url: open.url };

    const inFlight = this.pending.get(reservationId);
    if (inFlight) return inFlight;

    const created = this.createSession(reservation, idempotencyKey).finally(() => {
      this.pending.delete(reservationId);
    });
    this.pending.set(reservationId, created);
    return created;
  }

  /**
   * Odbiera zdarzenie od Stripe'a. Rzuca, gdy zwrot się nie udał — wtedy 500
   * i Stripe ponowi dostawę; zwrot ma stały klucz, więc nie zdubluje się.
   */
  async handleWebhook(rawBody: Buffer, signature: string): Promise<WebhookResult> {
    const { gateway } = this.options;
    if (!gateway) throw new PaymentsUnavailableError();

    let event: PaymentWebhookEvent;
    try {
      event = gateway.verifyWebhook(rawBody, signature);
    } catch (error) {
      if (error instanceof InvalidWebhookSignatureError) throw new InvalidSignatureError();
      throw error;
    }

    const base = { eventId: event.id, type: event.type };
    if (this.isProcessed(event.id)) return { ...base, duplicate: true };

    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        return { ...base, duplicate: false, ...(await this.handlePaid(event)) };
      case "checkout.session.expired":
        transaction(this.options.db, () => {
          if (event.session) this.setSessionStatus(event.session.id, "expired", null, ["open"]);
          this.markProcessed(event);
        });
        return { ...base, duplicate: false };
      default:
        // Inne zdarzenia nas nie dotyczą, ale potwierdzamy je, żeby Stripe ich nie ponawiał.
        transaction(this.options.db, () => this.markProcessed(event));
        return { ...base, duplicate: false };
    }
  }

  private async handlePaid(event: PaymentWebhookEvent): Promise<Pick<WebhookResult, "outcome" | "refunded">> {
    const session = event.session;
    // Płatność odroczona (np. przelew) — poczekamy na async_payment_succeeded.
    if (!session || session.paymentStatus !== "paid") {
      transaction(this.options.db, () => this.markProcessed(event));
      return {};
    }

    const outcome: PaymentOutcome = session.reservationId
      ? this.options.bookings.confirmPayment({
          reservationId: session.reservationId,
          sessionId: session.id,
          amount: session.amountTotal ?? -1,
          currency: session.currency ?? "",
          paidAt: event.created,
        })
      : { kind: "refund", reason: "unknown_reservation" };

    if (outcome.kind !== "refund") {
      transaction(this.options.db, () => {
        this.setSessionStatus(session.id, "completed", session.paymentIntent, ["open", "expired"]);
        this.markProcessed(event);
      });
      return { outcome };
    }

    // Pieniądze przyszły, a biletu nie wydamy: zwrot. Zdarzenie zapisujemy dopiero
    // po udanym zwrocie, inaczej powtórka od Stripe'a by go pominęła.
    let refunded = false;
    if (session.paymentIntent) {
      await this.options.gateway!.refund(session.paymentIntent, `pas-refund-${session.id}`);
      refunded = true;
    }
    transaction(this.options.db, () => {
      this.setSessionStatus(session.id, "refunded", session.paymentIntent, ["open", "expired", "completed"]);
      this.markProcessed(event);
    });
    return { outcome, refunded };
  }

  private async createSession(
    reservation: ReturnType<BookingService["assertPayable"]>,
    idempotencyKey: string,
  ): Promise<CheckoutResponse> {
    const { gateway, breaker, catalog, publicUrl, clock } = this.options;
    const event = catalog.getEvent(reservation.eventId);
    if (!gateway || !event) throw new PaymentsUnavailableError();

    const base = publicUrl.replace(/\/+$/, "");
    const reservationPath = `${base}/reservations/${encodeURIComponent(reservation.id)}`;
    // Termin sesji wynika z rezerwacji, nie z zegara: ten sam klucz zawsze daje
    // te same parametry, więc ponowienie u Stripe'a nie skończy się błędem idempotencji.
    const expiresAt = Date.parse(reservation.expiresAt) + MIN_STRIPE_SESSION_MS;

    let session;
    try {
      session = await breaker.fire(() =>
        gateway.createCheckoutSession(
          {
            reservationId: reservation.id,
            amount: reservation.amount,
            currency: "pln",
            productName: `Bilet: ${event.relation}`,
            description: `${formatEventDate(event.date)}, odjazd ${event.departureTime}. ${formatSeatLabel(reservation.seatId)}.`,
            customerEmail: reservation.email,
            successUrl: `${reservationPath}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
            cancelUrl: `${reservationPath}/payment/cancel`,
            expiresAt,
          },
          `pas-checkout-${reservation.id}-${idempotencyKey}`,
        ),
      );
    } catch (error) {
      // Stripe nie odpowiada, odmówił albo bezpiecznik jest otwarty: rezerwacja zostaje,
      // klient może spróbować ponownie z tym samym kluczem.
      throw new PaymentsUnavailableError(5, error);
    }

    const createdAt = new Date(clock()).toISOString();
    this.options.db
      .prepare(
        `INSERT INTO checkout_sessions
           (id, reservation_id, idempotency_key, url, amount, status, created_at, expires_at, payment_intent)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, NULL)
         ON CONFLICT (id) DO NOTHING`,
      )
      .run(
        session.id,
        reservation.id,
        idempotencyKey,
        session.url,
        reservation.amount,
        createdAt,
        new Date(session.expiresAt).toISOString(),
      );

    return { url: session.url };
  }

  private findByKey(reservationId: string, idempotencyKey: string): CheckoutSessionRow | null {
    const row = this.options.db
      .prepare(
        `SELECT id, url, expires_at FROM checkout_sessions
         WHERE reservation_id = ? AND idempotency_key = ? AND status = 'open'`,
      )
      .get(reservationId, idempotencyKey) as unknown as CheckoutSessionRow | undefined;
    return row ?? null;
  }

  private findOpen(reservationId: string): CheckoutSessionRow | null {
    const nowIso = new Date(this.options.clock()).toISOString();
    const row = this.options.db
      .prepare(
        `SELECT id, url, expires_at FROM checkout_sessions
         WHERE reservation_id = ? AND status = 'open' AND expires_at > ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(reservationId, nowIso) as unknown as CheckoutSessionRow | undefined;
    return row ?? null;
  }

  private setSessionStatus(
    sessionId: string,
    status: "completed" | "expired" | "refunded",
    paymentIntent: string | null,
    from: string[],
  ): void {
    const placeholders = from.map(() => "?").join(", ");
    this.options.db
      .prepare(
        `UPDATE checkout_sessions
         SET status = ?, payment_intent = COALESCE(?, payment_intent)
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(status, paymentIntent, sessionId, ...from);
  }

  private isProcessed(eventId: string): boolean {
    return Boolean(this.options.db.prepare("SELECT 1 FROM stripe_events WHERE id = ?").get(eventId));
  }

  private markProcessed(event: PaymentWebhookEvent): void {
    this.options.db
      .prepare("INSERT INTO stripe_events (id, type, received_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING")
      .run(event.id, event.type, new Date(this.options.clock()).toISOString());
  }
}
