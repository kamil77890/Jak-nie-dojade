import type { CheckoutResponse } from "@pas/shared";
import { formatEventDate, formatSeatLabel } from "@pas/shared";
import type { BookingService, PaymentOutcome } from "./booking";
import type { EventCatalog } from "./catalog";
import { type Db, transaction } from "./db";
import {
  InsufficientPointsError,
  InvalidSignatureError,
  PaymentsUnavailableError,
  PointsLimitExceededError,
  ReservationPaidError,
  ValidationError,
} from "./errors";
import { type JobQueue, REFUND_POINTS_TASK } from "./jobs";
import type { LoyaltyService } from "./loyalty";
import {
  type ExpireCheckoutResult,
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
  points_used: number;
  points_refunded_at: string | null;
}

export interface CheckoutServiceOptions {
  db: Db;
  bookings: BookingService;
  catalog: EventCatalog;
  /** null = Stripe nie jest skonfigurowany; checkout i webhook odpowiadają 503. */
  gateway: PaymentGateway | null;
  breaker: CircuitBreaker;
  /** Voucherify (albo fallback pamięciowy) — źródło prawdy o saldzie punktów. */
  loyalty: LoyaltyService;
  /** Kolejka jobów — zaległy zwrot punktów, gdy Voucherify nie przyjął go od razu. */
  jobs: JobQueue;
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
  /** Ile punktów wróciło na kartę klienta przy tym zdarzeniu (0 = nic do zwrotu). */
  pointsReturned?: number;
}

/**
 * Karta A (sesja Checkout) i karta B (webhook). Każde wywołanie Stripe'a niesie
 * Idempotency-Key, a każde zdarzenie webhooka jest księgowane dokładnie raz.
 */
export class CheckoutService {
  /**
   * Jedna operacja checkoutu naraz na rezerwację — dwa kliknięcia w dwóch kartach
   * nie dadzą dwóch płatności, a zmiana punktów nie ściga się z tworzeniem sesji.
   */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Trwające zwroty punktów per sesja — równoległy webhook czeka na ten sam wynik. */
  private readonly releasing = new Map<string, Promise<number>>();

  constructor(private readonly options: CheckoutServiceOptions) {}

  get enabled(): boolean {
    return this.options.gateway !== null;
  }

  async startCheckout(
    reservationId: string,
    idempotencyKey: string,
    points: number = 0,
  ): Promise<CheckoutResponse> {
    if (!this.options.gateway) throw new PaymentsUnavailableError();

    if (!Number.isSafeInteger(points) || points < 0) {
      throw new ValidationError("Liczba punktów musi być nieujemną liczbą całkowitą.");
    }

    return this.withLock(reservationId, () => this.checkoutLocked(reservationId, idempotencyKey, points));
  }

  /**
   * Odbiera zdarzenie od Stripe'a. Rzuca, gdy zwrot pieniędzy albo punktów się nie
   * udał — wtedy 5xx i Stripe ponowi dostawę; oba zwroty są idempotentne.
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
        if (event.session) {
          return { ...base, duplicate: false, ...(await this.handleExpired(event.session.id, event)) };
        }
        transaction(this.options.db, () => this.markProcessed(event));
        return { ...base, duplicate: false };
      default:
        // Inne zdarzenia nas nie dotyczą, ale potwierdzamy je, żeby Stripe ich nie ponawiał.
        transaction(this.options.db, () => this.markProcessed(event));
        return { ...base, duplicate: false };
    }
  }

  /**
   * Oddaje punkty pobrane przy tworzeniu sesji — dokładnie raz, niezależnie od tego,
   * kto o to prosi (wygaśnięcie, zwrot płatności, zmiana punktów) i ile razy.
   *
   * 1. W transakcji stawiamy `points_refunded_at` — tylko jeśli punkty nie wróciły
   *    i sesja nie opłaciła rezerwacji (wtedy punkty zostały wydane na bilet).
   * 2. Dopisujemy punkty w Voucherify.
   * 3. Gdy Voucherify padnie, zdejmujemy znacznik i rzucamy — wołający (webhook)
   *    odpowie 5xx, a ponowienie spróbuje jeszcze raz.
   *
   * Znacznik stawiany przed wywołaniem sprawia, że równoległe żądania nie oddadzą
   * punktów dwa razy, a `confirmPayment` (ta sama baza, BEGIN IMMEDIATE) nie wyda
   * biletu ze zniżką z sesji, której punkty już wróciły.
   */
  async releaseSessionPoints(sessionId: string): Promise<number> {
    const inFlight = this.releasing.get(sessionId);
    if (inFlight) return inFlight;

    const release = this.releaseOnce(sessionId).finally(() => this.releasing.delete(sessionId));
    this.releasing.set(sessionId, release);
    return release;
  }

  private async checkoutLocked(
    reservationId: string,
    idempotencyKey: string,
    points: number,
  ): Promise<CheckoutResponse> {
    const { bookings, loyalty } = this.options;

    // 404 / 409 RESERVATION_EXPIRED / 409 RESERVATION_PAID — zanim zawołamy Stripe'a.
    const reservation = bookings.assertPayable(reservationId);

    // Najwyżej połowa ceny biletu; resztę klient dopłaca kartą.
    const maxPoints = Math.floor(reservation.amount / 2);
    if (points > maxPoints) throw new PointsLimitExceededError();

    // Otwarta sesja z tą samą liczbą punktów: ta sama sesja (ten sam albo nowy klucz —
    // ponowienie po przerwaniu), bez drugiego wywołania Stripe'a i bez pobierania punktów.
    const open = this.findOpen(reservationId);
    if (open && open.points_used === points) return { url: open.url };

    if (points > 0) {
      // Punkty z wygasłych sesji tej rezerwacji, których zwrot wcześniej się nie udał
      // (Voucherify padł) — oddajemy je teraz, zanim policzymy saldo. Bez punktów nie
      // rozmawiamy z Voucherify wcale, więc płatność samą kartą działa i bez niego.
      for (const sessionId of this.unreleasedExpiredSessions(reservationId)) {
        await this.releaseSessionPoints(sessionId);
      }
      // Saldo sprawdzamy przed czymkolwiek nieodwracalnym. Punkty zastępowanej sesji
      // wrócą przed pobraniem nowych, więc liczą się do dostępnego salda.
      const returning = open && !open.points_refunded_at ? open.points_used : 0;
      const balance = await loyalty.getBalance(reservation.email);
      if (balance + returning < points) throw new InsufficientPointsError();
    }

    // Klient zmienił liczbę punktów: stara sesja ma inną kwotę niż „Zapłać X” w UI.
    // Wygaszamy ją u Stripe'a, oddajemy jej punkty i tworzymy nową.
    if (open) await this.replaceSession(open);

    return this.createSession(reservation, idempotencyKey, points);
  }

  /**
   * Kolejność ma znaczenie: najpierw Stripe (po wygaszeniu klient nie może już
   * zapłacić starej sesji), potem baza, na końcu punkty. Jeśli Stripe odpowie, że sesja
   * jest opłacona — nie ruszamy niczego, bilet wyda webhook.
   */
  private async replaceSession(open: CheckoutSessionRow): Promise<void> {
    const { gateway, breaker, db } = this.options;

    let state: ExpireCheckoutResult;
    try {
      state = await breaker.fire(() => gateway!.expireCheckoutSession(open.id, `pas-expire-${open.id}`));
    } catch (error) {
      // Stara sesja dalej działa — klient może nią zapłacić albo spróbować za chwilę.
      throw new PaymentsUnavailableError(5, error);
    }
    if (state === "complete") throw new ReservationPaidError();

    transaction(db, () => this.setSessionStatus(open.id, "expired", null, ["open"]));
    // Gdy Voucherify padnie: 503 LOYALTY_UNAVAILABLE, a punkty odda ponowienie albo
    // webhook `checkout.session.expired`, który Stripe wyśle dla wygaszonej sesji.
    await this.releaseSessionPoints(open.id);
  }

  private async handlePaid(
    event: PaymentWebhookEvent,
  ): Promise<Pick<WebhookResult, "outcome" | "refunded" | "pointsReturned">> {
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

    // Pieniądze przyszły, a biletu nie wydamy: zwrot pieniędzy i punktów tej sesji.
    // Status `refunded` od razu, żeby nikt nie podał klientowi jej adresu jako otwartej.
    // Zdarzenie zapisujemy dopiero po obu zwrotach — inaczej powtórka od Stripe'a by je
    // pominęła. Oba zwroty są idempotentne (klucz Stripe'a, `points_refunded_at`).
    transaction(this.options.db, () =>
      this.setSessionStatus(session.id, "refunded", session.paymentIntent, ["open", "expired", "completed"]),
    );
    let refunded = false;
    if (session.paymentIntent) {
      await this.options.gateway!.refund(session.paymentIntent, `pas-refund-${session.id}`);
      refunded = true;
    }
    // Punkty z TEJ sesji — przy `already_paid` sesja, która opłaciła bilet, zostaje nietknięta.
    const pointsReturned = await this.releaseSessionPoints(session.id);
    transaction(this.options.db, () => this.markProcessed(event));
    return { outcome, refunded, pointsReturned };
  }

  /**
   * Sesja wygasła bez płatności: punkty użyte do jej utworzenia wracają na kartę.
   * Status zmieniamy od razu (Stripe już jej nie przyjmie), zdarzenie zapisujemy po
   * zwrocie punktów — awaria Voucherify kończy się 5xx i ponowieniem od Stripe'a.
   */
  private async handleExpired(
    sessionId: string,
    event: PaymentWebhookEvent,
  ): Promise<Pick<WebhookResult, "pointsReturned">> {
    transaction(this.options.db, () => this.setSessionStatus(sessionId, "expired", null, ["open"]));
    const pointsReturned = await this.releaseSessionPoints(sessionId);
    transaction(this.options.db, () => this.markProcessed(event));
    return { pointsReturned };
  }

  private async releaseOnce(sessionId: string): Promise<number> {
    const { db, clock, loyalty } = this.options;
    const claimedAt = new Date(clock()).toISOString();

    const claim = transaction(db, () => {
      const row = db
        .prepare(
          `SELECT s.points_used AS points, r.email AS email
           FROM checkout_sessions s
           JOIN reservations r ON r.id = s.reservation_id
           WHERE s.id = ?
             AND s.points_used > 0
             AND s.points_refunded_at IS NULL
             AND (r.paid_session_id IS NULL OR r.paid_session_id <> s.id)`,
        )
        .get(sessionId) as unknown as { points: number; email: string } | undefined;
      if (!row) return null;
      db.prepare("UPDATE checkout_sessions SET points_refunded_at = ? WHERE id = ?").run(claimedAt, sessionId);
      return row;
    });
    if (!claim) return 0;

    try {
      await loyalty.awardPoints(claim.email, Number(claim.points));
    } catch (error) {
      // Voucherify nie potwierdził: zdejmujemy znacznik, żeby ponowienie oddało punkty.
      db.prepare(
        "UPDATE checkout_sessions SET points_refunded_at = NULL WHERE id = ? AND points_refunded_at = ?",
      ).run(sessionId, claimedAt);
      throw error;
    }
    return Number(claim.points);
  }

  private async createSession(
    reservation: ReturnType<BookingService["assertPayable"]>,
    idempotencyKey: string,
    points: number,
  ): Promise<CheckoutResponse> {
    const { gateway, breaker, catalog, publicUrl, clock, loyalty } = this.options;
    const event = catalog.getEvent(reservation.eventId);
    if (!gateway || !event) throw new PaymentsUnavailableError();

    const charged = reservation.amount - points;

    // Pierwsza sesja rezerwacji ma klucz z Etapu II. Każda kolejna (po wygaśnięciu albo
    // zmianie punktów) dostaje numer, bo Stripe pamięta klucz 24 h i oddałby starą,
    // już wygaszoną sesję. Liczba punktów w kluczu: ponowienie z inną liczbą punktów
    // po błędzie Stripe'a to inne parametry, więc nie może dzielić klucza.
    const attempt = this.countSessions(reservation.id);
    const attemptKey = attempt === 0 ? idempotencyKey : `${idempotencyKey}.${attempt}`;
    const stripeKey = `pas-checkout-${reservation.id}-${attemptKey}${points > 0 ? `-p${points}` : ""}`;

    const base = publicUrl.replace(/\/+$/, "");
    const reservationPath = `${base}/reservations/${encodeURIComponent(reservation.id)}`;
    // Termin sesji wynika z rezerwacji, nie z zegara: ten sam klucz zawsze daje
    // te same parametry, więc ponowienie u Stripe'a nie skończy się błędem idempotencji.
    const expiresAt = Date.parse(reservation.expiresAt) + MIN_STRIPE_SESSION_MS;

    // Punkty schodzą przed utworzeniem sesji; jeśli Stripe odmówi, wracają na kartę.
    if (points > 0) await loyalty.spendPoints(reservation.email, points);

    let session;
    try {
      session = await breaker.fire(() =>
        gateway.createCheckoutSession(
          {
            reservationId: reservation.id,
            amount: charged,
            currency: "pln",
            productName: `Bilet: ${event.relation}`,
            description: `${formatEventDate(event.date)}, odjazd ${event.departureTime}. ${formatSeatLabel(reservation.seatId)}.`,
            customerEmail: reservation.email,
            successUrl: `${reservationPath}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
            cancelUrl: `${reservationPath}/payment/cancel`,
            expiresAt,
          },
          stripeKey,
        ),
      );
    } catch (error) {
      // Stripe nie odpowiada, odmówił albo bezpiecznik jest otwarty: rezerwacja zostaje,
      // a punkty wracają, żeby klient mógł spróbować ponownie z tym samym kluczem.
      if (points > 0) await this.returnPointsAfterStripeFailure(reservation.id, reservation.email, points);
      throw new PaymentsUnavailableError(5, error);
    }

    // Sesja u Stripe'a istnieje, więc gdyby zapis się nie udał, punktów nie oddajemy
    // (klient mógłby nią zapłacić) — błąd idzie głośno jako 500.
    this.options.db
      .prepare(
        `INSERT INTO checkout_sessions
           (id, reservation_id, idempotency_key, url, amount, status, created_at, expires_at, payment_intent, points_used)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, NULL, ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .run(
        session.id,
        reservation.id,
        attemptKey,
        session.url,
        charged,
        new Date(clock()).toISOString(),
        new Date(session.expiresAt).toISOString(),
        points,
      );

    return { url: session.url };
  }

  /**
   * Stripe nie utworzył sesji, a punkty już zeszły z karty. Próbujemy oddać je od razu;
   * gdy Voucherify też nie odpowiada, zwrot trafia do kolejki jobów (retry z backoffem,
   * czekanie na limit, DLQ widoczne w /lab) zamiast przepaść. Każde wywołanie odpowiada
   * dokładnie jednemu pobraniu punktów (ponowienie z tym samym kluczem pobiera je od nowa),
   * więc każde dostaje własny job — wspólne id zgubiłoby drugi zwrot.
   */
  private async returnPointsAfterStripeFailure(
    reservationId: string,
    email: string,
    points: number,
  ): Promise<void> {
    try {
      await this.options.loyalty.awardPoints(email, points);
    } catch {
      this.options.jobs.enqueue(
        REFUND_POINTS_TASK,
        { reservationId, email, points, reason: "stripe_session_failed" },
        { now: this.options.clock() },
      );
    }
  }

  private findOpen(reservationId: string): CheckoutSessionRow | null {
    const nowIso = new Date(this.options.clock()).toISOString();
    const row = this.options.db
      .prepare(
        `SELECT id, url, expires_at, points_used, points_refunded_at FROM checkout_sessions
         WHERE reservation_id = ? AND status = 'open' AND expires_at > ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(reservationId, nowIso) as unknown as CheckoutSessionRow | undefined;
    return row ?? null;
  }

  private unreleasedExpiredSessions(reservationId: string): string[] {
    const rows = this.options.db
      .prepare(
        `SELECT id FROM checkout_sessions
         WHERE reservation_id = ? AND status = 'expired' AND points_used > 0 AND points_refunded_at IS NULL`,
      )
      .all(reservationId) as unknown as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  private countSessions(reservationId: string): number {
    const row = this.options.db
      .prepare("SELECT COUNT(*) AS total FROM checkout_sessions WHERE reservation_id = ?")
      .get(reservationId) as unknown as { total: number };
    return Number(row.total);
  }

  /** Kolejka per rezerwacja: następne żądanie startuje po zakończeniu poprzedniego. */
  private async withLock<T>(reservationId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(reservationId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(reservationId, tail);
    void tail.then(() => {
      if (this.locks.get(reservationId) === tail) this.locks.delete(reservationId);
    });
    return run;
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
