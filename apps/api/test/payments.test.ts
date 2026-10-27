import Stripe from "stripe";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CheckoutResponse,
  CreateReservationResponse,
  EventDetailResponse,
  EventListItem,
  ReservationStatusResponse,
} from "@pas/shared";
import {
  checkoutCompletedEvent,
  createTestContext,
  newIdempotencyKey,
  payReservation,
  reservationPayload,
  sendWebhook,
  startCheckout,
  stripeDown,
  TEST_WEBHOOK_SECRET,
  type TestContext,
} from "./helpers";

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
});

const PRICE = 8900;

async function reserve(seatId = "5-1"): Promise<CreateReservationResponse> {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/reservations",
    payload: reservationPayload({ seatId }),
  });
  expect(response.statusCode).toBe(201);
  return response.json<CreateReservationResponse>();
}

async function status(reservationId: string) {
  return ctx.app.inject({ method: "GET", url: `/api/reservations/${reservationId}` });
}

function paidEvent(reservationId: string, sessionId: string, overrides: Record<string, unknown> = {}) {
  return checkoutCompletedEvent(ctx, { sessionId, reservationId, amount: PRICE, ...overrides });
}

describe("ceny i kwota rezerwacji", () => {
  it("kurs ma cenę w groszach na liście i w szczegółach", async () => {
    ctx = await createTestContext();
    const list = await ctx.app.inject({ method: "GET", url: "/api/events" });
    for (const item of list.json<EventListItem[]>()) expect(item.price).toBe(PRICE);

    const detail = await ctx.app.inject({ method: "GET", url: "/api/events/ic-7310-2026-11-21" });
    expect(detail.json<EventDetailResponse>().event.price).toBe(PRICE);
  });

  it("rezerwacja zwraca kwotę zamrożoną w chwili rezerwacji", async () => {
    ctx = await createTestContext();
    const created = await reserve();
    expect(created.amount).toBe(PRICE);
  });
});

describe("GET /api/reservations/:id", () => {
  it("pokazuje held → paid z kodem", async () => {
    ctx = await createTestContext();
    const { reservationId, expiresAt } = await reserve();

    const held = await status(reservationId);
    expect(held.statusCode).toBe(200);
    expect(held.json()).toEqual({ status: "held", amount: PRICE, expiresAt });

    const { code } = await payReservation(ctx, reservationId);
    expect((await status(reservationId)).json()).toEqual({ status: "paid", amount: PRICE, expiresAt, code });
  });

  it("po TTL bez płatności pokazuje expired bez kodu", async () => {
    ctx = await createTestContext();
    const { reservationId } = await reserve();
    ctx.advance(ctx.services.config.ttlMs);

    expect((await status(reservationId)).json<ReservationStatusResponse>()).toMatchObject({
      status: "expired",
      amount: PRICE,
    });
  });

  it("nieznana rezerwacja daje 404", async () => {
    ctx = await createTestContext();
    const response = await status("nie-ma-takiej");
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "RESERVATION_NOT_FOUND" });
  });
});

describe("karta A — POST /api/reservations/:id/checkout", () => {
  it("bez Idempotency-Key odmawia 400 i nie woła Stripe'a", async () => {
    ctx = await createTestContext();
    const { reservationId } = await reserve();

    const missing = await startCheckout(ctx, reservationId, null);
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({ error: "IDEMPOTENCY_KEY_REQUIRED" });

    const tooShort = await startCheckout(ctx, reservationId, "abc");
    expect(tooShort.statusCode).toBe(400);
    const withSpace = await startCheckout(ctx, reservationId, "klucz z spacjami");
    expect(withSpace.statusCode).toBe(400);

    expect(ctx.payments.calls).toBe(0);
  });

  it("tworzy sesję z kwotą z rezerwacji, PLN i client_reference_id", async () => {
    ctx = await createTestContext({ overrides: { payments: { publicUrl: "https://kasa.example.com/" } } });
    const { reservationId, expiresAt } = await reserve();
    const key = newIdempotencyKey();

    const response = await startCheckout(ctx, reservationId, key);
    expect(response.statusCode).toBe(200);
    expect(response.json<CheckoutResponse>()).toEqual({ url: "https://checkout.stripe.test/c/pay/cs_test_1" });

    const [session] = ctx.payments.sessions;
    expect(session!.key).toBe(`pas-checkout-${reservationId}-${key}`);
    expect(session!.input).toMatchObject({
      reservationId,
      amount: PRICE,
      currency: "pln",
      customerEmail: "anna@example.com",
      successUrl: `https://kasa.example.com/reservations/${reservationId}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `https://kasa.example.com/reservations/${reservationId}/payment/cancel`,
    });
    // Stripe wymaga min. 30 min; termin liczony z rezerwacji, więc powtórka ma te same parametry.
    expect(session!.input.expiresAt).toBe(Date.parse(expiresAt) + 31 * 60_000);
  });

  it("ten sam Idempotency-Key zwraca tę samą sesję bez drugiego wywołania Stripe'a", async () => {
    ctx = await createTestContext();
    const { reservationId } = await reserve();
    const key = newIdempotencyKey();

    const first = await startCheckout(ctx, reservationId, key);
    const second = await startCheckout(ctx, reservationId, key);
    expect(second.json()).toEqual(first.json());
    expect(ctx.payments.calls).toBe(1);
  });

  it("ponowna próba po przerwaniu (nowy klucz) wraca do otwartej sesji zamiast tworzyć drugą", async () => {
    ctx = await createTestContext();
    const { reservationId } = await reserve();

    const first = await startCheckout(ctx, reservationId);
    const retry = await startCheckout(ctx, reservationId);
    expect(retry.json()).toEqual(first.json());
    expect(ctx.payments.sessions).toHaveLength(1);
  });

  it("dwa równoległe kliknięcia z różnymi kluczami dają jedną sesję", async () => {
    ctx = await createTestContext();
    const { reservationId } = await reserve();

    const [a, b] = await Promise.all([startCheckout(ctx, reservationId), startCheckout(ctx, reservationId)]);
    expect(a.statusCode).toBe(200);
    expect(b.json()).toEqual(a.json());
    expect(ctx.payments.sessions).toHaveLength(1);
  });

  it("odmawia 409 dla wygasłej i opłaconej rezerwacji, 404 dla nieznanej", async () => {
    ctx = await createTestContext();
    const paid = await reserve("5-1");
    await payReservation(ctx, paid.reservationId);
    const again = await startCheckout(ctx, paid.reservationId);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "RESERVATION_PAID" });

    const stale = await reserve("5-2");
    ctx.advance(ctx.services.config.ttlMs);
    const expired = await startCheckout(ctx, stale.reservationId);
    expect(expired.statusCode).toBe(409);
    expect(expired.json()).toEqual({ error: "RESERVATION_EXPIRED" });

    const unknown = await startCheckout(ctx, "nie-ma-takiej");
    expect(unknown.statusCode).toBe(404);
  });

  it("awaria Stripe'a daje 503, rezerwacja zostaje, a powtórka z tym samym kluczem przechodzi", async () => {
    ctx = await createTestContext();
    const { reservationId } = await reserve();
    const key = newIdempotencyKey();

    ctx.payments.failWith = stripeDown();
    const down = await startCheckout(ctx, reservationId, key);
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ error: "PAYMENTS_UNAVAILABLE" });
    expect((await status(reservationId)).json()).toMatchObject({ status: "held" });

    ctx.payments.failWith = null;
    const retry = await startCheckout(ctx, reservationId, key);
    expect(retry.statusCode).toBe(200);
    expect(ctx.payments.sessions).toHaveLength(1);
  });

  it("bezpiecznik po serii awarii przestaje wołać Stripe'a", async () => {
    ctx = await createTestContext({
      overrides: { payments: { breakerFailureThreshold: 2, breakerResetMs: 60_000 } },
    });
    const { reservationId } = await reserve();
    ctx.payments.failWith = stripeDown();

    await startCheckout(ctx, reservationId);
    await startCheckout(ctx, reservationId);
    const callsWhenOpened = ctx.payments.calls;

    const shortCircuit = await startCheckout(ctx, reservationId);
    expect(shortCircuit.statusCode).toBe(503);
    expect(ctx.payments.calls).toBe(callsWhenOpened);
    expect(ctx.services.paymentBreaker.state).toBe("open");
  });

  it("bez kluczy Stripe'a płatności odpowiadają 503", async () => {
    // Ten test buduje własną aplikację; afterEach nie może zamknąć poprzedniej drugi raz.
    ctx = undefined as unknown as TestContext;
    let built: Awaited<ReturnType<typeof import("../src/app")["buildApp"]>> | null = null;
    const { buildApp } = await import("../src/app");
    const { openDatabase } = await import("../src/db");
    const db = openDatabase(":memory:");
    try {
      built = await buildApp({
        db,
        paymentGateway: null,
        config: { rateLimit: { enabled: false }, webDistPath: null },
      });
      const created = await built.app.inject({
        method: "POST",
        url: "/api/reservations",
        payload: reservationPayload(),
      });
      const { reservationId } = created.json<CreateReservationResponse>();
      const response = await built.app.inject({
        method: "POST",
        url: `/api/reservations/${reservationId}/checkout`,
        headers: { "idempotency-key": newIdempotencyKey() },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: "PAYMENTS_UNAVAILABLE" });
    } finally {
      await built?.app.close();
      db.close();
    }
  });
});

describe("karta B — POST /api/webhooks/stripe", () => {
  async function openSession() {
    const { reservationId } = await reserve();
    await startCheckout(ctx, reservationId);
    return { reservationId, sessionId: ctx.payments.sessions.at(-1)!.result.id };
  }

  it("odrzuca zły podpis i brak podpisu bez zmiany stanu", async () => {
    ctx = await createTestContext();
    const { reservationId, sessionId } = await openSession();

    const forged = await sendWebhook(ctx, paidEvent(reservationId, sessionId), "whsec_obcy_sekret");
    expect(forged.statusCode).toBe(400);
    expect(forged.json()).toEqual({ error: "INVALID_SIGNATURE" });

    const unsigned = await ctx.app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(paidEvent(reservationId, sessionId)),
    });
    expect(unsigned.statusCode).toBe(400);

    expect((await status(reservationId)).json()).toMatchObject({ status: "held" });
    expect(ctx.services.jobs.stats().total).toBe(0);
  });

  it("podpis liczy się z surowych bajtów — zmieniona treść nie przechodzi", async () => {
    ctx = await createTestContext();
    const { reservationId, sessionId } = await openSession();
    const payload = JSON.stringify(paidEvent(reservationId, sessionId));
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET });

    // Ta sama treść JSON, inne bajty (formatowanie) — podpis już się nie zgadza.
    const reformatted = await ctx.app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload: JSON.stringify(JSON.parse(payload), null, 2),
    });
    expect(reformatted.statusCode).toBe(400);

    const exact = await ctx.app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload,
    });
    expect(exact.statusCode).toBe(200);
  });

  it("checkout.session.completed oznacza rezerwację jako opłaconą i kolejkuje e-mail", async () => {
    ctx = await createTestContext();
    const { reservationId, sessionId } = await openSession();

    const response = await sendWebhook(ctx, paidEvent(reservationId, sessionId));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    const after = (await status(reservationId)).json<ReservationStatusResponse>();
    expect(after.status).toBe("paid");
    expect(after.code).toMatch(/^PAS-[A-Z2-9]{6}$/);
    expect(ctx.services.jobs.stats().total).toBe(1);
  });

  it("ponowna dostawa tego samego zdarzenia nie zmienia kodu ani nie dubluje e-maila", async () => {
    ctx = await createTestContext();
    const { reservationId, sessionId } = await openSession();
    const event = paidEvent(reservationId, sessionId);

    await sendWebhook(ctx, event);
    const code = (await status(reservationId)).json<ReservationStatusResponse>().code;
    const replay = await sendWebhook(ctx, event);
    expect(replay.statusCode).toBe(200);

    // Inne zdarzenie o tej samej sesji (np. async_payment_succeeded) też nic nie zmienia.
    await sendWebhook(ctx, paidEvent(reservationId, sessionId, { type: "checkout.session.async_payment_succeeded" }));

    expect((await status(reservationId)).json<ReservationStatusResponse>().code).toBe(code);
    expect(ctx.services.jobs.stats().total).toBe(1);
    expect(ctx.payments.refunds).toHaveLength(0);
  });

  it("nieopłacona sesja (payment_status ≠ paid) nie wydaje biletu", async () => {
    ctx = await createTestContext();
    const { reservationId, sessionId } = await openSession();

    await sendWebhook(ctx, paidEvent(reservationId, sessionId, { paymentStatus: "unpaid" }));
    expect((await status(reservationId)).json()).toMatchObject({ status: "held" });
  });

  it("zapłata przed terminem, webhook po terminie: bilet się należy, jeśli miejsce wolne", async () => {
    ctx = await createTestContext();
    const { reservationId, sessionId } = await openSession();
    const paidAt = ctx.now() + 1_000;

    ctx.advance(ctx.services.config.ttlMs + 5_000);
    expect((await status(reservationId)).json()).toMatchObject({ status: "expired" });

    await sendWebhook(ctx, paidEvent(reservationId, sessionId, { paidAt }));
    expect((await status(reservationId)).json()).toMatchObject({ status: "paid" });
    expect(ctx.payments.refunds).toHaveLength(0);
  });

  it("zapłata przed terminem, ale miejsce zajął już ktoś inny: zwrot", async () => {
    ctx = await createTestContext();
    const { reservationId, sessionId } = await openSession();
    const paidAt = ctx.now() + 1_000;

    ctx.advance(ctx.services.config.ttlMs + 5_000);
    const other = await reserve("5-1");

    const response = await sendWebhook(ctx, paidEvent(reservationId, sessionId, { paidAt }));
    expect(response.statusCode).toBe(200);
    expect(ctx.payments.refunds).toEqual([{ paymentIntentId: `pi_${sessionId}`, key: `pas-refund-${sessionId}` }]);
    expect((await status(reservationId)).json()).toMatchObject({ status: "expired" });
    expect((await status(other.reservationId)).json()).toMatchObject({ status: "held" });
  });

  it("płatność po terminie rezerwacji: zwrot, bez biletu", async () => {
    ctx = await createTestContext();
    const { reservationId, sessionId } = await openSession();

    ctx.advance(ctx.services.config.ttlMs);
    await sendWebhook(ctx, paidEvent(reservationId, sessionId));

    expect((await status(reservationId)).json()).toMatchObject({ status: "expired" });
    expect(ctx.payments.refunds).toHaveLength(1);
    expect(ctx.services.jobs.stats().total).toBe(0);
  });

  it("kwota inna niż w rezerwacji: zwrot, bez biletu", async () => {
    ctx = await createTestContext();
    const { reservationId, sessionId } = await openSession();

    await sendWebhook(ctx, paidEvent(reservationId, sessionId, { amount: 100 }));
    expect((await status(reservationId)).json()).toMatchObject({ status: "held" });
    expect(ctx.payments.refunds).toHaveLength(1);
  });

  it("druga zapłacona sesja za opłaconą rezerwację: zwrot drugiej płatności", async () => {
    ctx = await createTestContext();
    const { reservationId, sessionId } = await openSession();
    await sendWebhook(ctx, paidEvent(reservationId, sessionId));
    const code = (await status(reservationId)).json<ReservationStatusResponse>().code;

    await sendWebhook(ctx, paidEvent(reservationId, "cs_test_obca"));
    expect(ctx.payments.refunds).toEqual([{ paymentIntentId: "pi_cs_test_obca", key: "pas-refund-cs_test_obca" }]);
    expect((await status(reservationId)).json<ReservationStatusResponse>().code).toBe(code);
  });

  it("nieudany zwrot daje 500, żeby Stripe ponowił; powtórka zwraca raz", async () => {
    ctx = await createTestContext();
    const { reservationId, sessionId } = await openSession();
    ctx.advance(ctx.services.config.ttlMs);
    const event = paidEvent(reservationId, sessionId);

    ctx.payments.failWith = stripeDown();
    const failed = await sendWebhook(ctx, event);
    expect(failed.statusCode).toBe(500);

    ctx.payments.failWith = null;
    expect((await sendWebhook(ctx, event)).statusCode).toBe(200);
    expect((await sendWebhook(ctx, event)).statusCode).toBe(200);
    expect(ctx.payments.refunds).toHaveLength(1);
  });

  it("checkout.session.expired zamyka sesję — następna próba tworzy nową", async () => {
    ctx = await createTestContext();
    const { reservationId, sessionId } = await openSession();

    const expired = await sendWebhook(ctx, {
      ...paidEvent(reservationId, sessionId, { paymentStatus: "unpaid" }),
      type: "checkout.session.expired",
    });
    expect(expired.statusCode).toBe(200);

    const retry = await startCheckout(ctx, reservationId);
    expect(retry.statusCode).toBe(200);
    expect(ctx.payments.sessions).toHaveLength(2);
  });

  it("nieznane typy zdarzeń są potwierdzane 200", async () => {
    ctx = await createTestContext();
    const response = await sendWebhook(ctx, {
      id: "evt_other",
      object: "event",
      type: "payment_intent.created",
      created: Math.floor(ctx.now() / 1000),
      data: { object: { id: "pi_1", object: "payment_intent" } },
    });
    expect(response.statusCode).toBe(200);
  });
});
