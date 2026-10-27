import Stripe from "stripe";

/** Dane potrzebne do sesji Checkout. Kwota zawsze z rezerwacji, nie od klienta. */
export interface CheckoutSessionInput {
  reservationId: string;
  amount: number;
  currency: "pln";
  productName: string;
  description: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  /** Unix ms. Stripe przyjmuje od 30 min do 24 h od teraz. */
  expiresAt: number;
}

export interface CreatedCheckoutSession {
  id: string;
  url: string;
  /** Unix ms. */
  expiresAt: number;
}

/** Interesujący nas wycinek zdarzenia Stripe'a — już po weryfikacji podpisu. */
export interface PaymentWebhookEvent {
  id: string;
  type: string;
  /** Kiedy Stripe utworzył zdarzenie, unix ms. */
  created: number;
  session?: {
    id: string;
    reservationId: string | null;
    amountTotal: number | null;
    currency: string | null;
    paymentStatus: string;
    paymentIntent: string | null;
  };
}

export interface PaymentGateway {
  createCheckoutSession(input: CheckoutSessionInput, idempotencyKey: string): Promise<CreatedCheckoutSession>;
  refund(paymentIntentId: string, idempotencyKey: string): Promise<void>;
  /** Rzuca `InvalidWebhookSignatureError`, gdy podpis się nie zgadza. */
  verifyWebhook(rawBody: Buffer, signature: string): PaymentWebhookEvent;
}

export class InvalidWebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWebhookSignatureError";
  }
}

/** Błąd po stronie Stripe'a albo sieci. `retryable` mówi, czy ponowienie ma sens. */
export class PaymentProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PaymentProviderError";
  }
}

/**
 * Weryfikacja podpisu nie potrzebuje klucza API ani sieci — wystarcza sekret
 * endpointu (whsec_…). Dlatego jest osobno i testy używają jej bez atrapy.
 */
export function verifyStripeWebhook(rawBody: Buffer, signature: string, secret: string): PaymentWebhookEvent {
  let event: Stripe.Event;
  try {
    event = Stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (error) {
    throw new InvalidWebhookSignatureError(error instanceof Error ? error.message : String(error));
  }
  return toWebhookEvent(event);
}

function toWebhookEvent(event: Stripe.Event): PaymentWebhookEvent {
  const base = { id: event.id, type: event.type, created: event.created * 1000 };
  if (!event.type.startsWith("checkout.session.")) return base;

  const session = event.data.object as Stripe.Checkout.Session;
  const paymentIntent =
    typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null);
  return {
    ...base,
    session: {
      id: session.id,
      reservationId: session.client_reference_id,
      amountTotal: session.amount_total,
      currency: session.currency,
      paymentStatus: session.payment_status,
      paymentIntent,
    },
  };
}

export interface StripeGatewayOptions {
  secretKey: string;
  webhookSecret: string;
  timeoutMs: number;
  maxNetworkRetries: number;
}

/**
 * Prawdziwy Stripe. SDK sam ponawia błędy sieci i 5xx, a przy każdym ponowieniu
 * wysyła ten sam Idempotency-Key — Stripe nie utworzy wtedy drugiej sesji ani zwrotu.
 */
export class StripeGateway implements PaymentGateway {
  private readonly stripe: Stripe;

  constructor(private readonly options: StripeGatewayOptions) {
    this.stripe = new Stripe(options.secretKey, {
      timeout: options.timeoutMs,
      maxNetworkRetries: options.maxNetworkRetries,
      appInfo: { name: "pas-s01-train-ticket" },
    });
  }

  async createCheckoutSession(
    input: CheckoutSessionInput,
    idempotencyKey: string,
  ): Promise<CreatedCheckoutSession> {
    const session = await this.call(() =>
      this.stripe.checkout.sessions.create(
        {
          mode: "payment",
          client_reference_id: input.reservationId,
          customer_email: input.customerEmail,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: input.currency,
                unit_amount: input.amount,
                product_data: { name: input.productName, description: input.description },
              },
            },
          ],
          metadata: { reservationId: input.reservationId },
          payment_intent_data: { metadata: { reservationId: input.reservationId } },
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          expires_at: Math.floor(input.expiresAt / 1000),
        },
        { idempotencyKey },
      ),
    );

    if (!session.url) throw new PaymentProviderError("Stripe nie zwrócił adresu sesji.", false);
    return { id: session.id, url: session.url, expiresAt: session.expires_at * 1000 };
  }

  async refund(paymentIntentId: string, idempotencyKey: string): Promise<void> {
    await this.call(() =>
      this.stripe.refunds.create(
        { payment_intent: paymentIntentId, reason: "requested_by_customer" },
        { idempotencyKey },
      ),
    );
  }

  verifyWebhook(rawBody: Buffer, signature: string): PaymentWebhookEvent {
    return verifyStripeWebhook(rawBody, signature, this.options.webhookSecret);
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError) {
        const status = error.statusCode ?? 0;
        const retryable =
          error instanceof Stripe.errors.StripeConnectionError ||
          error instanceof Stripe.errors.StripeRateLimitError ||
          status >= 500;
        throw new PaymentProviderError(`Stripe: ${error.type} ${status} ${error.message}`, retryable);
      }
      throw new PaymentProviderError(`Stripe: ${String(error)}`, true);
    }
  }
}

/** Klucze live są zakazane: Etap II działa wyłącznie w trybie testowym Stripe'a. */
export function isTestSecretKey(key: string): boolean {
  return key.startsWith("sk_test_") || key.startsWith("rk_test_");
}
