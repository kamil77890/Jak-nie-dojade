import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CreateReservationResponse, LoyaltyResponse, ReservationStatusResponse } from "@pas/shared";
import { openDatabase } from "../src/db";
import { LoyaltyProviderError, MemoryLoyaltyProvider, type LoyaltyProvider } from "../src/loyalty";
import {
  checkoutCompletedEvent,
  createTestContext,
  newIdempotencyKey,
  reservationPayload,
  sendWebhook,
  stripeDown,
  type TestContext,
} from "./helpers";

/**
 * Voucherify, który można „wyłączyć” w trakcie testu. `failAwards` psuje tylko
 * dopisywanie punktów (zwroty), a saldo i pobieranie działają — awaria w środku zwrotu.
 */
class SwitchableLoyalty implements LoyaltyProvider {
  readonly name = "memory" as const;
  private readonly inner = new MemoryLoyaltyProvider();
  down = false;
  failAwards = false;
  /** Udane dopisania punktów (delta > 0) — do sprawdzania „dokładnie raz”. */
  awards: number[] = [];

  async createMember(email: string) {
    this.check();
    return this.inner.createMember(email);
  }

  async getBalance(memberId: string) {
    this.check();
    return this.inner.getBalance(memberId);
  }

  async adjustPoints(memberId: string, delta: number, reason: string) {
    this.check();
    if (this.failAwards && delta > 0) throw new LoyaltyProviderError("Voucherify: timeout", true);
    const balance = await this.inner.adjustPoints(memberId, delta, reason);
    if (delta > 0 && reason !== "welcome") this.awards.push(delta);
    return balance;
  }

  private check(): void {
    if (this.down) throw new LoyaltyProviderError("Voucherify: 503", true);
  }
}

const PRICE = 8900;
const EMAIL = "anna@example.com";

let ctx: TestContext;
let provider: SwitchableLoyalty;

afterEach(async () => {
  await ctx?.close();
});

async function setup(): Promise<void> {
  provider = new SwitchableLoyalty();
  ctx = await createTestContext({ loyaltyProvider: provider });
}

async function reserve(seatId = "5-1", email = EMAIL): Promise<string> {
  const created = await ctx.app.inject({
    method: "POST",
    url: "/api/reservations",
    payload: reservationPayload({ seatId, email }),
  });
  expect(created.statusCode).toBe(201);
  return created.json<CreateReservationResponse>().reservationId;
}

function checkout(reservationId: string, points?: unknown, key = newIdempotencyKey()) {
  return ctx.app.inject({
    method: "POST",
    url: `/api/reservations/${reservationId}/checkout`,
    headers: { "idempotency-key": key },
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

function paid(reservationId: string, session = lastSession(), overrides: Record<string, unknown> = {}) {
  return checkoutCompletedEvent(ctx, {
    sessionId: session.result.id,
    reservationId,
    amount: session.input.amount,
    ...overrides,
  });
}

function expiredEvent(reservationId: string, session = lastSession()) {
  return { ...paid(reservationId, session, { paymentStatus: "unpaid" }), type: "checkout.session.expired" };
}

function sessionRow(sessionId: string) {
  return ctx.services.db
    .prepare("SELECT status, points_used, points_refunded_at FROM checkout_sessions WHERE id = ?")
    .get(sessionId) as { status: string; points_used: number; points_refunded_at: string | null };
}

describe("zadanie 1 — zwrot płatności oddaje punkty tej sesji dokładnie raz", () => {
  it("płatność po terminie: zwrot pieniędzy i punktów, powtórka webhooka nic nie dubluje", async () => {
    await setup();
    const reservationId = await reserve();
    expect((await checkout(reservationId, 1000)).statusCode).toBe(200);
    expect(await balance()).toBe(0);

    ctx.advance(ctx.services.config.ttlMs);
    const event = paid(reservationId);
    expect((await sendWebhook(ctx, event)).statusCode).toBe(200);

    expect(ctx.payments.refunds).toHaveLength(1);
    expect(await balance()).toBe(1000);
    expect(provider.awards).toEqual([1000]);
    expect(sessionRow(lastSession().result.id)).toMatchObject({ status: "refunded" });
    const after = await status(reservationId);
    expect(after).toMatchObject({ status: "expired", pointsUsed: 0 });
    expect(after).not.toHaveProperty("pointsEarned");

    // Stripe dostarcza „co najmniej raz”.
    expect((await sendWebhook(ctx, event)).statusCode).toBe(200);
    expect(await balance()).toBe(1000);
    expect(ctx.payments.refunds).toHaveLength(1);
    expect(provider.awards).toEqual([1000]);
  });

  it("kwota się nie zgadza: zwrot punktów, rezerwacja trwa i można zapłacić od nowa", async () => {
    await setup();
    const reservationId = await reserve();
    await checkout(reservationId, 1000);

    await sendWebhook(ctx, paid(reservationId, lastSession(), { amount: 100 }));
    expect(ctx.payments.refunds).toHaveLength(1);
    expect(await balance()).toBe(1000);
    expect(await status(reservationId)).toMatchObject({ status: "held", pointsUsed: 0 });

    // Sesja zwrócona nie jest już „otwarta” — nowa próba tworzy nową sesję.
    const again = await checkout(reservationId, 1000);
    expect(again.statusCode).toBe(200);
    expect(ctx.payments.sessions).toHaveLength(2);
    expect(await balance()).toBe(0);
  });

  it("miejsce zajęte w międzyczasie (UNIQUE): zwrot pieniędzy i punktów", async () => {
    await setup();
    const reservationId = await reserve();
    await checkout(reservationId, 1000);
    const paidAt = ctx.now() + 1_000;

    ctx.advance(ctx.services.config.ttlMs + 5_000);
    await reserve("5-1", "ktos@example.com");

    const response = await sendWebhook(ctx, paid(reservationId, lastSession(), { paidAt }));
    expect(response.statusCode).toBe(200);
    expect(ctx.payments.refunds).toHaveLength(1);
    expect(await balance()).toBe(1000);
  });

  it("druga opłacona sesja: wracają punkty TEJ sesji, a punkty sesji z biletem zostają wydane", async () => {
    await setup();
    const reservationId = await reserve();
    await checkout(reservationId, 300);
    const first = lastSession();
    expect((await sendWebhook(ctx, paid(reservationId, first))).statusCode).toBe(200);
    expect(await balance()).toBe(700);

    // Druga sesja z punktami (np. z innej instancji API) — zapisana i opłacona po fakcie.
    await ctx.services.loyalty.withSpendLock(EMAIL, (lock) => ctx.services.loyalty.spendPoints(lock, 200));
    ctx.services.db
      .prepare(
        `INSERT INTO checkout_sessions
           (id, reservation_id, idempotency_key, url, amount, status, created_at, expires_at, points_used)
         VALUES ('cs_test_druga', ?, 'inna-instancja', 'https://checkout.stripe.test/x', 8700, 'open', ?, ?, 200)`,
      )
      .run(reservationId, new Date(ctx.now()).toISOString(), new Date(ctx.now() + 3_600_000).toISOString());
    expect(await balance()).toBe(500);

    const second = checkoutCompletedEvent(ctx, { sessionId: "cs_test_druga", reservationId, amount: 8700 });
    expect((await sendWebhook(ctx, second)).statusCode).toBe(200);
    expect(ctx.payments.refunds).toEqual([{ paymentIntentId: "pi_cs_test_druga", key: "pas-refund-cs_test_druga" }]);
    expect(await balance()).toBe(700);
    expect(await status(reservationId)).toMatchObject({ status: "paid", pointsUsed: 300 });
    expect(sessionRow(first.result.id).points_refunded_at).toBeNull();

    // Powtórka nie oddaje niczego drugi raz.
    await sendWebhook(ctx, second);
    expect(await balance()).toBe(700);
  });

  it("nieznana rezerwacja: zwrot pieniędzy, punktów do oddania brak", async () => {
    await setup();
    const response = await sendWebhook(
      ctx,
      checkoutCompletedEvent(ctx, { sessionId: "cs_test_obca", reservationId: null, amount: PRICE }),
    );
    expect(response.statusCode).toBe(200);
    expect(ctx.payments.refunds).toHaveLength(1);
    expect(provider.awards).toEqual([]);
  });

  it("Voucherify pada w środku zwrotu: 503 bez szczegółów, ponowienie oddaje punkty raz, pieniądze też raz", async () => {
    await setup();
    const reservationId = await reserve();
    await checkout(reservationId, 1000);
    ctx.advance(ctx.services.config.ttlMs);
    const event = paid(reservationId);

    provider.failAwards = true;
    const failed = await sendWebhook(ctx, event);
    // Stripe ponawia każdą odpowiedź spoza 2xx; ciało nie zdradza przyczyny.
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ error: "LOYALTY_UNAVAILABLE", message: expect.any(String), retryAfter: 5 });
    expect(failed.headers["retry-after"]).toBe("5");
    expect(ctx.payments.refunds).toHaveLength(1);
    expect(sessionRow(lastSession().result.id).points_refunded_at).toBeNull();

    provider.failAwards = false;
    expect((await sendWebhook(ctx, event)).statusCode).toBe(200);
    expect((await sendWebhook(ctx, event)).statusCode).toBe(200);
    expect(provider.awards).toEqual([1000]);
    expect(ctx.payments.refunds).toHaveLength(1);
    expect(await balance()).toBe(1000);
  });

  it("Stripe pada przy zwrocie: 500 bez szczegółów, punkty wracają dopiero przy udanym ponowieniu", async () => {
    await setup();
    const reservationId = await reserve();
    await checkout(reservationId, 1000);
    ctx.advance(ctx.services.config.ttlMs);
    const event = paid(reservationId);

    ctx.payments.failWith = stripeDown();
    const failed = await sendWebhook(ctx, event);
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: "INTERNAL_ERROR", message: expect.any(String) });
    expect(provider.awards).toEqual([]);

    ctx.payments.failWith = null;
    expect((await sendWebhook(ctx, event)).statusCode).toBe(200);
    expect(ctx.payments.refunds).toHaveLength(1);
    expect(provider.awards).toEqual([1000]);
  });

  it("wygaśnięcie sesji przy awarii Voucherify: 503, ponowienie oddaje punkty dokładnie raz", async () => {
    await setup();
    const reservationId = await reserve();
    await checkout(reservationId, 1000);
    const event = expiredEvent(reservationId);

    provider.failAwards = true;
    expect((await sendWebhook(ctx, event)).statusCode).toBe(503);
    // Stripe już sesji nie przyjmie — status zmieniony od razu, punkty czekają na ponowienie.
    expect(sessionRow(lastSession().result.id)).toMatchObject({ status: "expired", points_refunded_at: null });
    expect(await status(reservationId)).toMatchObject({ pointsUsed: 1000 });

    provider.failAwards = false;
    expect((await sendWebhook(ctx, event)).statusCode).toBe(200);
    expect((await sendWebhook(ctx, event)).statusCode).toBe(200);
    expect(provider.awards).toEqual([1000]);
    expect(await status(reservationId)).toMatchObject({ pointsUsed: 0 });
  });

  it("płatność za sesję, której punkty już wróciły, idzie do zwrotu — bez biletu ze zniżką", async () => {
    await setup();
    const reservationId = await reserve();
    await checkout(reservationId, 1000);
    const session = lastSession();
    await sendWebhook(ctx, expiredEvent(reservationId, session));
    expect(await balance()).toBe(1000);

    // Zła kolejność zdarzeń: `completed` po `expired` tej samej sesji.
    expect((await sendWebhook(ctx, paid(reservationId, session))).statusCode).toBe(200);
    expect(ctx.payments.refunds).toHaveLength(1);
    expect(await status(reservationId)).toMatchObject({ status: "held", pointsUsed: 0 });
    expect(await balance()).toBe(1000);
    expect(provider.awards).toEqual([1000]);
  });
});

describe("zadanie 2 — zmiana liczby punktów przy otwartej sesji", () => {
  it("ten sam klucz i te same punkty: ta sama sesja, bez Stripe'a i bez drugiego pobrania", async () => {
    await setup();
    const reservationId = await reserve();
    const key = newIdempotencyKey();

    const first = await checkout(reservationId, 1000, key);
    const second = await checkout(reservationId, 1000, key);
    const otherKey = await checkout(reservationId, 1000);
    expect(second.json()).toEqual(first.json());
    expect(otherKey.json()).toEqual(first.json());
    expect(ctx.payments.calls).toBe(1);
    expect(await balance()).toBe(0);
  });

  it("ten sam klucz, inne punkty: stara sesja wygaszona, punkty oddane raz, nowa sesja z nową kwotą", async () => {
    await setup();
    const reservationId = await reserve();
    const key = newIdempotencyKey();

    const first = await checkout(reservationId, 1000, key);
    const old = lastSession();
    expect(await balance()).toBe(0);

    const changed = await checkout(reservationId, 400, key);
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).not.toEqual(first.json());
    const fresh = lastSession();
    expect(fresh.input.amount).toBe(PRICE - 400);
    // Nowy klucz u Stripe'a — stary oddałby wygaszoną sesję.
    expect(fresh.key).not.toBe(old.key);
    expect(ctx.payments.expired).toEqual([{ sessionId: old.result.id, key: `pas-expire-${old.result.id}` }]);
    expect(sessionRow(old.result.id)).toMatchObject({ status: "expired" });
    expect(await balance()).toBe(600);
    expect(await status(reservationId)).toMatchObject({ status: "held", pointsUsed: 400 });

    // Powtórka z nową liczbą punktów — idempotentna względem nowej sesji.
    expect((await checkout(reservationId, 400, key)).json()).toEqual(changed.json());

    // Stripe wysyła `expired` dla sesji wygaszonej przez API — punkty już wróciły.
    expect((await sendWebhook(ctx, expiredEvent(reservationId, old))).statusCode).toBe(200);
    expect(await balance()).toBe(600);
    expect(provider.awards).toEqual([1000]);

    await sendWebhook(ctx, paid(reservationId, fresh));
    const done = await status(reservationId);
    expect(done).toMatchObject({ status: "paid", pointsUsed: 400, pointsEarned: 850 });
  });

  it("nowy klucz, zero punktów: zwrot punktów i sesja na pełną kwotę", async () => {
    await setup();
    const reservationId = await reserve();
    await checkout(reservationId, 1000);

    const card = await checkout(reservationId, 0);
    expect(card.statusCode).toBe(200);
    expect(lastSession().input.amount).toBe(PRICE);
    expect(await balance()).toBe(1000);
    expect(await status(reservationId)).toMatchObject({ pointsUsed: 0 });
  });

  it("brak body przy otwartej sesji z punktami to też zmiana (0 punktów)", async () => {
    await setup();
    const reservationId = await reserve();
    await checkout(reservationId, 500);
    expect((await checkout(reservationId)).statusCode).toBe(200);
    expect(ctx.payments.sessions).toHaveLength(2);
    expect(await balance()).toBe(1000);
  });

  it("za mało punktów na nową liczbę: 409, stara sesja zostaje nietknięta", async () => {
    await setup();
    const reservationId = await reserve();
    const first = await checkout(reservationId, 400);
    // Saldo 600 + 400 wracające = 1000 < 1001.
    const tooMany = await checkout(reservationId, 1001);
    expect(tooMany.statusCode).toBe(409);
    expect(tooMany.json()).toEqual({ error: "INSUFFICIENT_POINTS", message: expect.any(String) });
    expect(ctx.payments.expired).toEqual([]);
    expect(await balance()).toBe(600);
    expect((await checkout(reservationId, 400)).json()).toEqual(first.json());

    // Dokładnie tyle, ile da się złożyć ze zwrotem — przechodzi.
    expect((await checkout(reservationId, 1000)).statusCode).toBe(200);
    expect(await balance()).toBe(0);
  });

  it("Stripe nie odpowiada przy wygaszaniu: 503, stara sesja dalej działa, punkty bez zmian", async () => {
    await setup();
    const reservationId = await reserve();
    const first = await checkout(reservationId, 1000);

    ctx.payments.failWith = stripeDown();
    const down = await checkout(reservationId, 200);
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ error: "PAYMENTS_UNAVAILABLE" });
    expect(down.headers["retry-after"]).toBe("5");
    ctx.payments.failWith = null;

    expect(await balance()).toBe(0);
    expect((await checkout(reservationId, 1000)).json()).toEqual(first.json());
    expect(ctx.payments.sessions).toHaveLength(1);
  });

  it("stara sesja już opłacona u Stripe'a: 409 RESERVATION_PAID, bez nowej sesji i bez zwrotu punktów", async () => {
    await setup();
    const reservationId = await reserve();
    await checkout(reservationId, 1000);
    const old = lastSession();
    ctx.payments.completed.add(old.result.id);

    const response = await checkout(reservationId, 0);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "RESERVATION_PAID", message: expect.any(String) });
    expect(ctx.payments.sessions).toHaveLength(1);
    expect(await balance()).toBe(0);

    // Webhook dochodzi — bilet z punktami tej sesji.
    await sendWebhook(ctx, paid(reservationId, old));
    expect(await status(reservationId)).toMatchObject({ status: "paid", pointsUsed: 1000, pointsEarned: 790 });
  });

  it("Voucherify pada przy zwrocie punktów starej sesji: 503, a webhook `expired` oddaje je raz", async () => {
    await setup();
    const reservationId = await reserve();
    await checkout(reservationId, 1000);
    const old = lastSession();

    provider.failAwards = true;
    const failed = await checkout(reservationId, 0);
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({ error: "LOYALTY_UNAVAILABLE" });
    expect(sessionRow(old.result.id)).toMatchObject({ status: "expired", points_refunded_at: null });
    // Punkty nie przepadły — status nadal pokazuje je jako pobrane.
    expect(await status(reservationId)).toMatchObject({ pointsUsed: 1000 });

    // Płatność samą kartą nie zależy od Voucherify.
    expect((await checkout(reservationId, 0)).statusCode).toBe(200);

    provider.failAwards = false;
    expect((await sendWebhook(ctx, expiredEvent(reservationId, old))).statusCode).toBe(200);
    expect(provider.awards).toEqual([1000]);
    expect(await balance()).toBe(1000);
  });

  it("ponowienie checkoutu z punktami samo dokańcza zaległy zwrot (bez czekania na webhook)", async () => {
    await setup();
    const reservationId = await reserve();
    await checkout(reservationId, 1000);
    const old = lastSession();

    provider.failAwards = true;
    expect((await checkout(reservationId, 500)).statusCode).toBe(503);
    provider.failAwards = false;

    const retry = await checkout(reservationId, 500);
    expect(retry.statusCode).toBe(200);
    expect(lastSession().input.amount).toBe(PRICE - 500);
    expect(await balance()).toBe(500);

    // Spóźniony webhook `expired` niczego już nie dubluje.
    await sendWebhook(ctx, expiredEvent(reservationId, old));
    expect(provider.awards).toEqual([1000]);
    expect(await balance()).toBe(500);
  });

  it("wyścig: `completed` starej sesji po jej wygaszeniu — zwrot płatności, bilet tylko z nowej sesji", async () => {
    await setup();
    const reservationId = await reserve();
    await checkout(reservationId, 1000);
    const old = lastSession();
    await checkout(reservationId, 200);
    const fresh = lastSession();
    expect(await balance()).toBe(800);

    expect((await sendWebhook(ctx, paid(reservationId, old))).statusCode).toBe(200);
    expect(ctx.payments.refunds).toEqual([{ paymentIntentId: `pi_${old.result.id}`, key: `pas-refund-${old.result.id}` }]);
    expect(await status(reservationId)).toMatchObject({ status: "held", pointsUsed: 200 });
    expect(await balance()).toBe(800);

    await sendWebhook(ctx, paid(reservationId, fresh));
    expect(await status(reservationId)).toMatchObject({ status: "paid", pointsUsed: 200 });
    expect(provider.awards).toEqual([1000]);
  });

  it("równoległe żądania z różnymi punktami są szeregowane — saldo i sesje się zgadzają", async () => {
    await setup();
    const reservationId = await reserve();
    await balance();

    const [a, b] = await Promise.all([checkout(reservationId, 300), checkout(reservationId, 700)]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(ctx.payments.sessions).toHaveLength(2);
    expect(ctx.payments.expired).toHaveLength(1);
    expect(lastSession().input.amount).toBe(PRICE - 700);
    expect(await balance()).toBe(300);
    expect(await status(reservationId)).toMatchObject({ pointsUsed: 700 });
  });
});

describe("zadanie 3 — pointsUsed / pointsEarned w GET /api/reservations/:id", () => {
  it("pointsEarned tylko po opłaceniu; pointsUsed pokazuje punkty pobrane i niezwrócone", async () => {
    await setup();
    const reservationId = await reserve();

    const fresh = await status(reservationId);
    expect(fresh).toEqual({ status: "held", amount: PRICE, expiresAt: fresh.expiresAt, pointsUsed: 0 });

    await checkout(reservationId, 1000);
    const pending = await status(reservationId);
    expect(pending.pointsUsed).toBe(1000);
    expect(pending).not.toHaveProperty("pointsEarned");
    expect(pending).not.toHaveProperty("code");

    await sendWebhook(ctx, paid(reservationId));
    expect(await status(reservationId)).toMatchObject({ status: "paid", pointsUsed: 1000, pointsEarned: 790 });
  });

  it("wygasła rezerwacja bez płatności nie ma pointsEarned", async () => {
    await setup();
    const reservationId = await reserve();
    ctx.advance(ctx.services.config.ttlMs);
    const expired = await status(reservationId);
    expect(expired).toMatchObject({ status: "expired", pointsUsed: 0 });
    expect(expired).not.toHaveProperty("pointsEarned");
  });
});

describe("zadanie 4 — kody HTTP i walidacja checkoutu z punktami", () => {
  it("points w złym formacie → 400 VALIDATION_ERROR i żadnego wywołania Stripe'a ani Voucherify", async () => {
    await setup();
    const reservationId = await reserve();

    for (const points of [true, {}, [100], "100", -5, 0.5, 1e300, Number.MAX_SAFE_INTEGER + 1]) {
      const response = await checkout(reservationId, points);
      expect(response.statusCode, JSON.stringify(points)).toBe(400);
      expect(response.json()).toEqual({ error: "VALIDATION_ERROR", message: expect.any(String) });
    }

    const arrayBody = await ctx.app.inject({
      method: "POST",
      url: `/api/reservations/${reservationId}/checkout`,
      headers: { "idempotency-key": newIdempotencyKey(), "content-type": "application/json" },
      payload: "[1000]",
    });
    expect(arrayBody.statusCode).toBe(400);

    const brokenJson = await ctx.app.inject({
      method: "POST",
      url: `/api/reservations/${reservationId}/checkout`,
      headers: { "idempotency-key": newIdempotencyKey(), "content-type": "application/json" },
      payload: '{"points": 10',
    });
    expect(brokenJson.statusCode).toBe(400);
    expect(brokenJson.json()).toEqual({ error: "VALIDATION_ERROR", message: expect.any(String) });

    expect(ctx.payments.calls).toBe(0);
  });

  it("`points: null` to brak punktów (Etap II)", async () => {
    await setup();
    const reservationId = await reserve();
    expect((await checkout(reservationId, null)).statusCode).toBe(200);
    expect(lastSession().input.amount).toBe(PRICE);
  });

  it("duża, ale poprawna liczba → 409 POINTS_LIMIT_EXCEEDED; nieznana rezerwacja → 404", async () => {
    await setup();
    const reservationId = await reserve();

    const huge = await checkout(reservationId, 1_000_000_000);
    expect(huge.statusCode).toBe(409);
    expect(huge.json()).toEqual({ error: "POINTS_LIMIT_EXCEEDED", message: expect.any(String) });

    const half = await checkout(reservationId, PRICE / 2 + 1);
    expect(half.statusCode).toBe(409);

    const unknown = await checkout("nie-ma-takiej", 100);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: "RESERVATION_NOT_FOUND", message: expect.any(String) });

    // Pusty identyfikator po trim — 400, jak w reszcie /api/reservations/:id.
    const blank = await ctx.app.inject({
      method: "POST",
      url: "/api/reservations/%20/checkout",
      headers: { "idempotency-key": newIdempotencyKey() },
    });
    expect(blank.statusCode).toBe(400);
  });

  it("Voucherify niedostępny: z punktami 503 + Retry-After, bez punktów płatność kartą działa", async () => {
    await setup();
    const reservationId = await reserve();
    provider.down = true;

    const withPoints = await checkout(reservationId, 100);
    expect(withPoints.statusCode).toBe(503);
    expect(withPoints.headers["retry-after"]).toBe("5");
    expect(withPoints.json()).toEqual({ error: "LOYALTY_UNAVAILABLE", message: expect.any(String), retryAfter: 5 });
    expect(ctx.payments.calls).toBe(0);

    const cardOnly = await checkout(reservationId, 0);
    expect(cardOnly.statusCode).toBe(200);
    expect(lastSession().input.amount).toBe(PRICE);
  });

  it("checkout opłaconej rezerwacji z punktami → 409 RESERVATION_PAID, punkty nietknięte", async () => {
    await setup();
    const reservationId = await reserve();
    await checkout(reservationId, 100);
    await sendWebhook(ctx, paid(reservationId));

    const again = await checkout(reservationId, 200);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "RESERVATION_PAID", message: expect.any(String) });
    expect(await balance()).toBe(900);
  });
});

describe("migracja bazy — points_refunded_at", () => {
  it("dodaje kolumnę i oznacza punkty wygasłych sesji jako już zwrócone (stary kod je oddał)", async () => {
    // Ten test nie buduje aplikacji; afterEach nie może zamknąć poprzedniej drugi raz.
    ctx = undefined as unknown as TestContext;
    const dir = mkdtempSync(join(tmpdir(), "pas-migration-"));
    const path = join(dir, "old.sqlite");
    try {
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
      const old = new DatabaseSync(path);
      old.exec(`
        CREATE TABLE checkout_sessions (
          id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
          url TEXT NOT NULL, amount INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'expired', 'refunded')),
          created_at TEXT NOT NULL, expires_at TEXT NOT NULL, payment_intent TEXT,
          points_used INTEGER NOT NULL DEFAULT 0,
          UNIQUE (reservation_id, idempotency_key)
        );
        INSERT INTO checkout_sessions VALUES ('cs_expired', 'r1', 'k1', 'u', 7900, 'expired', '2026-11-01', '2026-11-02', NULL, 1000);
        INSERT INTO checkout_sessions VALUES ('cs_open', 'r2', 'k2', 'u', 7900, 'open', '2026-11-01', '2026-11-02', NULL, 1000);
        INSERT INTO checkout_sessions VALUES ('cs_card', 'r3', 'k3', 'u', 8900, 'expired', '2026-11-01', '2026-11-02', NULL, 0);
      `);
      old.close();

      const db = openDatabase(path);
      const rows = db
        .prepare("SELECT id, points_refunded_at FROM checkout_sessions ORDER BY id")
        .all() as Array<{ id: string; points_refunded_at: string | null }>;
      db.close();
      expect(rows).toEqual([
        { id: "cs_card", points_refunded_at: null },
        { id: "cs_expired", points_refunded_at: "2026-11-01" },
        { id: "cs_open", points_refunded_at: null },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Stripe i Voucherify padają naraz przy tworzeniu sesji", () => {
  /** Karta + bonus powitalny przed awarią — inaczej test psułby samo założenie konta. */
  async function setupWithAccount(): Promise<string> {
    await setup();
    await ctx.services.loyalty.ensureAccount(EMAIL, "critical");
    return reserve();
  }

  function refundJobs() {
    return ctx.services.db
      .prepare("SELECT input, completed_at FROM jobs WHERE task = 'refund-points' ORDER BY created_at")
      .all() as Array<{ input: string; completed_at: string | null }>;
  }

  it("zwrot punktów trafia do kolejki zamiast przepaść; worker oddaje każde pobranie dokładnie raz", async () => {
    const reservationId = await setupWithAccount();
    const key = newIdempotencyKey();

    ctx.payments.failWith = stripeDown();
    provider.failAwards = true;

    // Dwie próby z tym samym kluczem = dwa osobne pobrania punktów, więc dwa zaległe zwroty.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failed = await checkout(reservationId, 500, key);
      expect(failed.statusCode).toBe(503);
      expect(failed.json()).toMatchObject({ error: "PAYMENTS_UNAVAILABLE" });
    }
    expect(provider.awards).toEqual([]);
    expect(refundJobs()).toHaveLength(2);
    expect(JSON.parse(refundJobs()[0]!.input)).toEqual({
      reservationId,
      email: EMAIL,
      points: 500,
      reason: "stripe_session_failed",
    });
    expect(await balance()).toBe(0);

    // Voucherify wstał: worker oddaje oba pobrania, a trzecie przejście nie ma nic do roboty.
    provider.failAwards = false;
    expect(await ctx.services.worker.runOnce()).toBe(true);
    expect(await ctx.services.worker.runOnce()).toBe(true);
    expect(await ctx.services.worker.runOnce()).toBe(false);
    expect(provider.awards).toEqual([500, 500]);
    expect(refundJobs().every((job) => job.completed_at !== null)).toBe(true);
    expect(await balance()).toBe(1000);

    // Stripe wstał: klient płaci z punktami jak zwykle.
    ctx.payments.failWith = null;
    expect((await checkout(reservationId, 500, key)).statusCode).toBe(200);
    expect(await balance()).toBe(500);
  });

  it("gdy Voucherify przyjmie zwrot od razu, kolejka zostaje pusta", async () => {
    await setup();
    const reservationId = await reserve();

    ctx.payments.failWith = stripeDown();
    expect((await checkout(reservationId, 1000)).statusCode).toBe(503);
    expect(provider.awards).toEqual([1000]);
    expect(refundJobs()).toHaveLength(0);
    expect(await balance()).toBe(1000);
  });

  it("zwrot wciąż nie wchodzi: job wraca z backoffem, a nie znika", async () => {
    const reservationId = await setupWithAccount();

    ctx.payments.failWith = stripeDown();
    provider.failAwards = true;
    expect((await checkout(reservationId, 1000)).statusCode).toBe(503);

    expect(await ctx.services.worker.runOnce()).toBe(true);
    expect(refundJobs()[0]!.completed_at).toBeNull();
    expect(ctx.services.worker.snapshot().failed).toBe(1);

    provider.failAwards = false;
    ctx.advance(60_000);
    expect(await ctx.services.worker.runOnce()).toBe(true);
    expect(provider.awards).toEqual([1000]);
    expect(await balance()).toBe(1000);
  });
});
