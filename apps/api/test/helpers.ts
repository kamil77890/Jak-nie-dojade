import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { buildApp, type BuildAppOptions, type AppServices } from "../src/app";
import { openDatabase } from "../src/db";
import { MailDeliveryError, type Mailer, type SendResult, type TicketMail } from "../src/mail";
import {
  type CheckoutSessionInput,
  type CreatedCheckoutSession,
  type PaymentGateway,
  PaymentProviderError,
  type PaymentWebhookEvent,
  verifyStripeWebhook,
} from "../src/payments";

export const TEST_WEBHOOK_SECRET = "whsec_test_pas_s01";

/**
 * Atrapa Stripe'a: sesje i zwroty bez sieci, z tą samą semantyką Idempotency-Key
 * (ten sam klucz → ta sama odpowiedź). Podpis webhooka sprawdza prawdziwe SDK.
 */
export class FakePaymentGateway implements PaymentGateway {
  sessions: Array<{ input: CheckoutSessionInput; key: string; result: CreatedCheckoutSession }> = [];
  refunds: Array<{ paymentIntentId: string; key: string }> = [];
  /** Liczba wywołań API, łącznie z powtórkami o tym samym kluczu. */
  calls = 0;
  failWith: Error | null = null;

  async createCheckoutSession(input: CheckoutSessionInput, key: string): Promise<CreatedCheckoutSession> {
    this.calls += 1;
    if (this.failWith) throw this.failWith;
    const replay = this.sessions.find((session) => session.key === key);
    if (replay) return replay.result;

    const id = `cs_test_${this.sessions.length + 1}`;
    const result = { id, url: `https://checkout.stripe.test/c/pay/${id}`, expiresAt: input.expiresAt };
    this.sessions.push({ input, key, result });
    return result;
  }

  async refund(paymentIntentId: string, key: string): Promise<void> {
    this.calls += 1;
    if (this.failWith) throw this.failWith;
    if (!this.refunds.some((refund) => refund.key === key)) this.refunds.push({ paymentIntentId, key });
  }

  verifyWebhook(rawBody: Buffer, signature: string): PaymentWebhookEvent {
    return verifyStripeWebhook(rawBody, signature, TEST_WEBHOOK_SECRET);
  }
}

export function stripeDown(): PaymentProviderError {
  return new PaymentProviderError("Stripe: api_error 500", true);
}

export class FakeMailer implements Mailer {
  calls: Array<{ message: TicketMail; key: string }> = [];
  failWith: Error | null = null;

  async send(message: TicketMail, key: string): Promise<SendResult> {
    this.calls.push({ message, key });
    if (this.failWith) throw this.failWith;
    return { id: `mail-${this.calls.length}`, duplicate: false };
  }
}

export interface TestContext {
  app: FastifyInstance;
  services: AppServices;
  mailer: FakeMailer;
  payments: FakePaymentGateway;
  advance: (ms: number) => void;
  now: () => number;
  close: () => Promise<void>;
}

export async function createTestContext(options: {
  overrides?: BuildAppOptions["config"];
  mailer?: FakeMailer;
  mailAdmin?: BuildAppOptions["mailAdmin"];
  payments?: FakePaymentGateway;
} = {}): Promise<TestContext> {
  let current = Date.parse("2026-11-01T09:00:00.000Z");
  const clock = () => current;
  const db = openDatabase(":memory:");
  const mailer = options.mailer ?? new FakeMailer();
  const payments = options.payments ?? new FakePaymentGateway();

  const built = await buildApp({
    db,
    clock,
    mailer,
    paymentGateway: payments,
    ...(options.mailAdmin ? { mailAdmin: options.mailAdmin } : {}),
    startWorker: false,
    config: {
      rateLimit: { enabled: false },
      // Testy nie zależą od tego, czy ktoś zbudował apps/web.
      webDistPath: null,
      worker: { enabled: false, baseBackoffMs: 1_000, maxBackoffMs: 60_000 },
      mail: { retryBaseDelayMs: 0, breakerFailureThreshold: 100 },
      ...options.overrides,
    },
  });

  return {
    app: built.app,
    services: built.services,
    mailer,
    payments,
    advance: (ms: number) => {
      current += ms;
    },
    now: () => current,
    close: async () => {
      await built.app.close();
      db.close();
    },
  };
}

export function reservationPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: "ic-7310-2026-11-21",
    seatId: "5-1",
    customerName: "Anna Kowalska",
    email: "anna@example.com",
    ...overrides,
  };
}

export function transientMailError(): MailDeliveryError {
  return new MailDeliveryError("Dostawca padł", true, 503);
}

export function permanentMailError(): MailDeliveryError {
  return new MailDeliveryError("Zły adres", false, 422);
}

let keyCounter = 0;

/** Unikalny Idempotency-Key, jak z `crypto.randomUUID()` w przeglądarce. */
export function newIdempotencyKey(): string {
  keyCounter += 1;
  return `test-key-${keyCounter.toString().padStart(4, "0")}`;
}

export function startCheckout(ctx: TestContext, reservationId: string, key: string | null = newIdempotencyKey()) {
  return ctx.app.inject({
    method: "POST",
    url: `/api/reservations/${reservationId}/checkout`,
    headers: key === null ? {} : { "idempotency-key": key },
  });
}

let eventCounter = 0;

export interface CompletedSessionOptions {
  sessionId: string;
  reservationId: string | null;
  amount: number;
  /** Czas płatności u Stripe'a; domyślnie zegar testu. */
  paidAt?: number;
  currency?: string;
  eventId?: string;
  type?: string;
  paymentStatus?: string;
}

/** Zdarzenie `checkout.session.completed` w kształcie, w jakim wysyła je Stripe. */
export function checkoutCompletedEvent(ctx: TestContext, options: CompletedSessionOptions): Record<string, unknown> {
  eventCounter += 1;
  return {
    id: options.eventId ?? `evt_test_${eventCounter}`,
    object: "event",
    type: options.type ?? "checkout.session.completed",
    created: Math.floor((options.paidAt ?? ctx.now()) / 1000),
    data: {
      object: {
        id: options.sessionId,
        object: "checkout.session",
        client_reference_id: options.reservationId,
        amount_total: options.amount,
        currency: options.currency ?? "pln",
        payment_status: options.paymentStatus ?? "paid",
        payment_intent: `pi_${options.sessionId}`,
      },
    },
  };
}

/** Wysyła zdarzenie z prawdziwym nagłówkiem Stripe-Signature. */
export function sendWebhook(ctx: TestContext, event: unknown, secret = TEST_WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  return ctx.app.inject({
    method: "POST",
    url: "/api/webhooks/stripe",
    headers: { "content-type": "application/json; charset=utf-8", "stripe-signature": signature },
    payload,
  });
}

/** Pełna ścieżka Etapu II: sesja Checkout → webhook → status `paid` z kodem. */
export async function payReservation(ctx: TestContext, reservationId: string): Promise<{ code: string; sessionId: string }> {
  const checkout = await startCheckout(ctx, reservationId);
  if (checkout.statusCode !== 200) {
    throw new Error(`checkout ${checkout.statusCode}: ${checkout.body}`);
  }
  const session = ctx.payments.sessions.at(-1)!;
  const webhook = await sendWebhook(
    ctx,
    checkoutCompletedEvent(ctx, { sessionId: session.result.id, reservationId, amount: session.input.amount }),
  );
  if (webhook.statusCode !== 200) throw new Error(`webhook ${webhook.statusCode}: ${webhook.body}`);

  const status = await ctx.app.inject({ method: "GET", url: `/api/reservations/${reservationId}` });
  const code = status.json<{ code?: string }>().code;
  if (!code) throw new Error(`brak kodu po płatności: ${status.body}`);
  return { code, sessionId: session.result.id };
}
