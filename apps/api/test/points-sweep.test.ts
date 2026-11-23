import { afterEach, describe, expect, it } from "vitest";
import type { CreateReservationResponse, LoyaltyResponse, ReservationStatusResponse } from "@pas/shared";
import { LoyaltyProviderError, LoyaltyThrottledError } from "../src/loyalty";
import {
  checkoutCompletedEvent,
  createTestContext,
  newIdempotencyKey,
  reservationPayload,
  sendWebhook,
  stripeDown,
  type TestContext,
} from "./helpers";
import { CountingLoyaltyProvider } from "./loyalty-helpers";

/**
 * III.B4: punkty pobrane na sesję porzuconej rezerwacji wracają najpóźniej 15 s po
 * `expiresAt` (zamiatanie co 2 s), a sesji ze zniżką nie da się już opłacić.
 */

const EMAIL = "anna@example.com";

let ctx: TestContext;
let provider: CountingLoyaltyProvider;

afterEach(async () => {
  await ctx?.close();
});

async function setup(): Promise<void> {
  provider = new CountingLoyaltyProvider();
  ctx = await createTestContext({ loyaltyProvider: provider });
}

async function reserve(seatId = "5-1", email = EMAIL): Promise<CreateReservationResponse> {
  const created = await ctx.app.inject({
    method: "POST",
    url: "/api/reservations",
    payload: reservationPayload({ seatId, email }),
  });
  expect(created.statusCode).toBe(201);
  return created.json<CreateReservationResponse>();
}

function checkout(reservationId: string, points?: number) {
  return ctx.app.inject({
    method: "POST",
    url: `/api/reservations/${reservationId}/checkout`,
    headers: { "idempotency-key": newIdempotencyKey() },
    ...(points === undefined ? {} : { payload: { points } }),
  });
}

async function balance(email = EMAIL): Promise<number> {
  const response = await ctx.app.inject({ method: "GET", url: `/api/loyalty?email=${encodeURIComponent(email)}` });
  expect(response.statusCode).toBe(200);
  return response.json<LoyaltyResponse>().points;
}

async function status(reservationId: string): Promise<ReservationStatusResponse> {
  const response = await ctx.app.inject({ method: "GET", url: `/api/reservations/${reservationId}` });
  expect(response.statusCode).toBe(200);
  return response.json<ReservationStatusResponse>();
}

function lastSession() {
  return ctx.payments.sessions.at(-1)!;
}

function sessionRow(sessionId: string) {
  return ctx.services.db
    .prepare("SELECT status, points_refunded_at FROM checkout_sessions WHERE id = ?")
    .get(sessionId) as { status: string; points_refunded_at: string | null };
}

/** Przesuwa zegar na `expiresAt + ms`. */
function advanceTo(expiresAt: string, ms: number): void {
  ctx.advance(Date.parse(expiresAt) + ms - ctx.now());
}

/** Rezerwacja z checkoutem na 1000 punktów: saldo 0, sesja na 7900. */
async function abandonedWithPoints(): Promise<{ reservationId: string; expiresAt: string; sessionId: string }> {
  const { reservationId, expiresAt } = await reserve();
  expect((await checkout(reservationId, 1000)).statusCode).toBe(200);
  expect(lastSession().input.amount).toBe(7900);
  expect(await balance()).toBe(0);
  return { reservationId, expiresAt, sessionId: lastSession().result.id };
}

describe("zwrot punktów po wygaśnięciu rezerwacji (III.B4)", () => {
  it("punkty wracają w kilka sekund po expiresAt: sesja wygaszona w Stripe, saldo 1000, pointsUsed 0", async () => {
    await setup();
    const { reservationId, expiresAt, sessionId } = await abandonedWithPoints();
    expect(await status(reservationId)).toMatchObject({ status: "held", pointsUsed: 1000 });

    // Przed expiresAt nic się nie dzieje — klient może jeszcze zapłacić.
    advanceTo(expiresAt, -1_000);
    expect(await ctx.services.sweeper.runOnce()).toMatchObject({ scanned: 0, released: 0 });
    expect(ctx.payments.expired).toHaveLength(0);
    expect(await balance()).toBe(0);

    // Pierwszy przebieg po expiresAt (zamiatanie co 2 s).
    advanceTo(expiresAt, 2_000);
    expect(await ctx.services.sweeper.runOnce()).toMatchObject({ scanned: 1, released: 1, failed: 0 });
    expect(ctx.payments.expired).toEqual([{ sessionId, key: `pas-expire-${sessionId}` }]);
    expect(sessionRow(sessionId)).toMatchObject({ status: "expired", points_refunded_at: expect.any(String) });
    expect(await balance()).toBe(1000);
    const after = await status(reservationId);
    expect(after).toMatchObject({ status: "expired", pointsUsed: 0 });
    expect(after).not.toHaveProperty("pointsEarned");

    // Kolejne przebiegi nie wołają już ani Stripe'a, ani Voucherify.
    const calls = provider.calls.length;
    ctx.advance(10_000);
    expect(await ctx.services.sweeper.runOnce()).toMatchObject({ scanned: 0 });
    expect(provider.calls).toHaveLength(calls);
    expect(ctx.payments.expired).toHaveLength(1);
  });

  it("checkout.session.expired od Stripe'a po naszym zwrocie (także powtórzony) nie dubluje punktów", async () => {
    await setup();
    const { reservationId, expiresAt, sessionId } = await abandonedWithPoints();
    advanceTo(expiresAt, 2_000);
    await ctx.services.sweeper.runOnce();
    expect(await balance()).toBe(1000);

    const expired = {
      ...checkoutCompletedEvent(ctx, { sessionId, reservationId, amount: 7900, paymentStatus: "unpaid" }),
      type: "checkout.session.expired",
    };
    expect((await sendWebhook(ctx, expired)).statusCode).toBe(200);
    expect(await balance()).toBe(1000);
    expect((await sendWebhook(ctx, expired)).statusCode).toBe(200);
    expect(await balance()).toBe(1000);
    expect(provider.calls.filter((call) => call.op === "adjustPoints" && call.reason === "purchase")).toHaveLength(1);
  });

  it("sesji ze zniżką nie da się opłacić po zwrocie: spóźniona płatność kończy się zwrotem pieniędzy, saldo zostaje 1000", async () => {
    await setup();
    const { reservationId, expiresAt, sessionId } = await abandonedWithPoints();
    advanceTo(expiresAt, 2_000);
    await ctx.services.sweeper.runOnce();

    // Prawdziwy Stripe odmówi zapłaty wygaszonej sesji. Gdyby jednak doszedł `completed`
    // (np. zapłata tuż przed wygaszeniem), nie ma biletu ze zniżką i nie ma drugiego zwrotu punktów.
    const late = checkoutCompletedEvent(ctx, { sessionId, reservationId, amount: 7900 });
    const response = await sendWebhook(ctx, late);
    expect(response.statusCode).toBe(200);
    expect(ctx.payments.refunds).toEqual([{ paymentIntentId: `pi_${sessionId}`, key: `pas-refund-${sessionId}` }]);
    expect(await balance()).toBe(1000);
    expect(await status(reservationId)).toMatchObject({ status: "expired", pointsUsed: 0 });
  });

  it("Stripe mówi „opłacona”: punktów nie oddajemy, bilet wydaje webhook; Stripe pytany znowu dopiero po minucie", async () => {
    await setup();
    const { reservationId, expiresAt, sessionId } = await abandonedWithPoints();
    // Klient zapłacił sekundę przed expiresAt, webhook jeszcze nie dotarł.
    ctx.payments.completed.add(sessionId);

    advanceTo(expiresAt, 2_000);
    expect(await ctx.services.sweeper.runOnce()).toMatchObject({ scanned: 1, paid: 1, released: 0 });
    expect(await balance()).toBe(0);
    expect(sessionRow(sessionId)).toMatchObject({ status: "open", points_refunded_at: null });

    const stripeCalls = ctx.payments.calls;
    ctx.advance(30_000);
    expect(await ctx.services.sweeper.runOnce()).toMatchObject({ scanned: 0 });
    expect(ctx.payments.calls).toBe(stripeCalls);

    const paidEvent = checkoutCompletedEvent(ctx, {
      sessionId,
      reservationId,
      amount: 7900,
      paidAt: Date.parse(expiresAt) - 1_000,
    });
    expect((await sendWebhook(ctx, paidEvent)).statusCode).toBe(200);
    expect(await status(reservationId)).toMatchObject({ status: "paid", pointsUsed: 1000, pointsEarned: 790 });

    ctx.advance(60_000);
    expect(await ctx.services.sweeper.runOnce()).toMatchObject({ scanned: 0 });
    expect(await balance()).toBe(0);
  });

  it("webhook completed równolegle z zamiataniem: jeden zwrot punktów i jeden zwrot pieniędzy", async () => {
    await setup();
    const { reservationId, expiresAt, sessionId } = await abandonedWithPoints();
    advanceTo(expiresAt, 2_000);

    const late = checkoutCompletedEvent(ctx, { sessionId, reservationId, amount: 7900 });
    const [swept, webhook] = await Promise.all([ctx.services.sweeper.runOnce(), sendWebhook(ctx, late)]);
    expect(webhook.statusCode).toBe(200);
    expect(swept.failed).toBe(0);

    expect(await balance()).toBe(1000);
    expect(provider.calls.filter((call) => call.op === "adjustPoints" && call.delta === 1000 && call.reason === "purchase")).toHaveLength(1);
    expect(ctx.payments.refunds).toHaveLength(1);
    expect(await status(reservationId)).toMatchObject({ status: "expired", pointsUsed: 0 });
  });

  it("Stripe niedostępny: sesja czeka (backoff), punkty wracają w następnym przebiegu", async () => {
    await setup();
    const { expiresAt, sessionId } = await abandonedWithPoints();
    ctx.payments.failWith = stripeDown();

    advanceTo(expiresAt, 2_000);
    expect(await ctx.services.sweeper.runOnce()).toMatchObject({ scanned: 1, failed: 1, released: 0 });
    expect(sessionRow(sessionId)).toMatchObject({ status: "open", points_refunded_at: null });
    expect(await balance()).toBe(0);

    ctx.payments.failWith = null;
    ctx.advance(1_000);
    // Backoff 2 s: jeszcze nie teraz.
    expect(await ctx.services.sweeper.runOnce()).toMatchObject({ scanned: 0 });
    ctx.advance(1_000);
    expect(await ctx.services.sweeper.runOnce()).toMatchObject({ scanned: 1, released: 1 });
    expect(await balance()).toBe(1000);
  });

  it("Voucherify niedostępny: sesja już wygaszona, punkty wracają po przywróceniu — Stripe pytany raz", async () => {
    await setup();
    const { reservationId, expiresAt, sessionId } = await abandonedWithPoints();
    provider.failNext.adjustPoints = new LoyaltyProviderError("Voucherify 503", true, 503);

    advanceTo(expiresAt, 2_000);
    expect(await ctx.services.sweeper.runOnce()).toMatchObject({ failed: 1, released: 0 });
    // Stripe już nie przyjmie płatności, punkty czekają na Voucherify.
    expect(sessionRow(sessionId)).toMatchObject({ status: "expired", points_refunded_at: null });
    expect(await status(reservationId)).toMatchObject({ status: "expired", pointsUsed: 1000 });

    // W międzyczasie Stripe przysyła `expired`, ale Voucherify dalej leży: 503 i ponowienie od Stripe'a.
    const expired = {
      ...checkoutCompletedEvent(ctx, { sessionId, reservationId, amount: 7900, paymentStatus: "unpaid" }),
      type: "checkout.session.expired",
    };
    provider.failNext.adjustPoints = new LoyaltyProviderError("Voucherify 503", true, 503);
    expect((await sendWebhook(ctx, expired)).statusCode).toBe(503);

    // Voucherify wrócił: następny przebieg (po backoffie) oddaje punkty, potem powtórka webhooka niczego nie dubluje.
    ctx.advance(4_000);
    expect(await ctx.services.sweeper.runOnce()).toMatchObject({ released: 1 });
    expect((await sendWebhook(ctx, expired)).statusCode).toBe(200);
    expect(await balance()).toBe(1000);
    // Dwie nieudane próby (zamiatanie, webhook) i jedna udana — saldo pokazuje, że zwrot doszedł raz.
    expect(provider.calls.filter((call) => call.op === "adjustPoints" && call.reason === "purchase")).toHaveLength(3);
    expect(ctx.payments.expired).toHaveLength(1);
    expect(await status(reservationId)).toMatchObject({ pointsUsed: 0 });
  });

  it("limit Voucherify: następna próba dopiero po Retry-After, nie co 2 s", async () => {
    await setup();
    const { expiresAt } = await abandonedWithPoints();
    provider.failNext.adjustPoints = new LoyaltyThrottledError("budżet", 120, "budget");

    advanceTo(expiresAt, 2_000);
    expect(await ctx.services.sweeper.runOnce()).toMatchObject({ failed: 1 });
    const calls = provider.calls.length;
    ctx.advance(60_000);
    expect(await ctx.services.sweeper.runOnce()).toMatchObject({ scanned: 0 });
    expect(provider.calls).toHaveLength(calls);
    ctx.advance(60_000);
    expect(await ctx.services.sweeper.runOnce()).toMatchObject({ released: 1 });
    expect(await balance()).toBe(1000);
  });

  it("nie rusza sesji bez punktów ani opłaconych rezerwacji", async () => {
    await setup();
    const cardOnly = await reserve("5-1");
    expect((await checkout(cardOnly.reservationId)).statusCode).toBe(200);
    const paidOne = await reserve("5-2");
    expect((await checkout(paidOne.reservationId, 500)).statusCode).toBe(200);
    const session = lastSession();
    const event = checkoutCompletedEvent(ctx, {
      sessionId: session.result.id,
      reservationId: paidOne.reservationId,
      amount: session.input.amount,
    });
    expect((await sendWebhook(ctx, event)).statusCode).toBe(200);

    advanceTo(paidOne.expiresAt, 60_000);
    expect(await ctx.services.sweeper.runOnce()).toMatchObject({ scanned: 0 });
    expect(ctx.payments.expired).toHaveLength(0);
    expect(await status(paidOne.reservationId)).toMatchObject({ status: "paid", pointsUsed: 500 });
  });

  it("zaległy zwrot po nieudanej zmianie punktów (sesja wygaszona, Voucherify padł) też wraca bez nowego checkoutu", async () => {
    await setup();
    const { reservationId } = await reserve();
    expect((await checkout(reservationId, 1000)).statusCode).toBe(200);
    const first = lastSession().result.id;
    // Zmiana punktów: Stripe wygasza starą sesję, ale zwrot jej punktów się nie udaje.
    provider.failNext.adjustPoints = new LoyaltyProviderError("Voucherify 503", true, 503);
    expect((await checkout(reservationId, 500)).statusCode).toBe(503);
    expect(sessionRow(first)).toMatchObject({ status: "expired", points_refunded_at: null });

    expect(await ctx.services.sweeper.runOnce()).toMatchObject({ released: 1 });
    expect(await balance()).toBe(1000);
  });

  it("w aplikacji zamiatanie startuje samo (interwał) i oddaje punkty bez żadnego requestu", async () => {
    provider = new CountingLoyaltyProvider();
    ctx = await createTestContext({ loyaltyProvider: provider, overrides: { pointsSweep: { intervalMs: 20 } } });
    const { expiresAt } = await abandonedWithPoints();
    advanceTo(expiresAt, 1_000);

    ctx.services.sweeper.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ctx.services.sweeper.snapshot()).toMatchObject({ released: 1, failed: 0 });
    expect(await balance()).toBe(1000);
  });
});
