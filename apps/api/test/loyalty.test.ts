import { afterEach, describe, expect, it } from "vitest";
import type {
  CreateReservationResponse,
  LoyaltyResponse,
  ReservationStatusResponse,
} from "@pas/shared";
import {
  checkoutCompletedEvent,
  createTestContext,
  newIdempotencyKey,
  reservationPayload,
  sendWebhook,
  type TestContext,
} from "./helpers";
import { LoyaltyProviderError, type LoyaltyProvider } from "../src/loyalty";
import { seedAccount } from "./loyalty-helpers";

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
});

async function reserve(email = "anna@example.com"): Promise<string> {
  const created = await ctx.app.inject({
    method: "POST",
    url: "/api/reservations",
    payload: reservationPayload({ email }),
  });
  expect(created.statusCode).toBe(201);
  return created.json<CreateReservationResponse>().reservationId;
}

function loyalty(email: string) {
  return ctx.app.inject({
    method: "GET",
    url: `/api/loyalty?email=${encodeURIComponent(email)}`,
  });
}

function checkout(reservationId: string, points?: number) {
  return ctx.app.inject({
    method: "POST",
    url: `/api/reservations/${reservationId}/checkout`,
    headers: { "idempotency-key": newIdempotencyKey() },
    ...(points === undefined ? {} : { payload: { points } }),
  });
}

describe("karta A — saldo punktów (Voucherify)", () => {
  it("nowy e-mail dostaje 1000 punktów, a powtórka nie dubluje bonusu", async () => {
    ctx = await createTestContext();

    const first = await loyalty("nowy@example.com");
    expect(first.statusCode).toBe(200);
    expect(first.json<LoyaltyResponse>()).toEqual({ email: "nowy@example.com", points: 1000 });

    const second = await loyalty("nowy@example.com");
    expect(second.json<LoyaltyResponse>()).toEqual({ email: "nowy@example.com", points: 1000 });
  });

  it("normalizuje e-mail i odrzuca niepoprawny adres", async () => {
    ctx = await createTestContext();

    const mixed = await loyalty("  NOWY@Example.COM ");
    expect(mixed.statusCode).toBe(200);
    expect(mixed.json<LoyaltyResponse>()).toEqual({ email: "nowy@example.com", points: 1000 });

    const broken = await loyalty("to-nie-jest-email");
    expect(broken.statusCode).toBe(400);
    expect(broken.json()).toMatchObject({ error: "VALIDATION_ERROR" });
  });

  it("awaria Voucherify to 503 LOYALTY_UNAVAILABLE, a nie 500", async () => {
    const broken: LoyaltyProvider = {
      name: "memory",
      createMember: async () => {
        throw new LoyaltyProviderError("Voucherify padł", true);
      },
      getBalance: async () => {
        throw new LoyaltyProviderError("Voucherify padł", true);
      },
      adjustPoints: async () => {
        throw new LoyaltyProviderError("Voucherify padł", true);
      },
    };
    ctx = await createTestContext({ loyaltyProvider: broken });
    // Konto z kartą — saldo trzeba przeczytać z Voucherify (nowy e-mail go nie potrzebuje).
    seedAccount(ctx, "anna@example.com", "CARD-anna");

    const response = await loyalty("anna@example.com");
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("5");
    // Nic wewnętrznego nie wycieka: tylko kod i czas ponowienia.
    expect(response.json()).toEqual({ error: "LOYALTY_UNAVAILABLE", retryAfter: 5 });

    // E-mail, który nic nie kupił, ma 1000 punktów bez pytania Voucherify — nawet w awarii.
    const fresh = await loyalty("nowy@example.com");
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json<LoyaltyResponse>().points).toBe(1000);
  });
});

describe("karta B — płatność punktami", () => {
  it("zmniejsza kwotę sesji, odejmuje punkty i nalicza 10 pkt za pełny złoty", async () => {
    ctx = await createTestContext();
    const reservationId = await reserve();

    const started = await checkout(reservationId, 1000);
    expect(started.statusCode).toBe(200);
    expect(ctx.payments.sessions.at(-1)?.input.amount).toBe(7900);

    const afterSpend = (await loyalty("anna@example.com")).json<LoyaltyResponse>();
    expect(afterSpend.points).toBe(0);

    const session = ctx.payments.sessions.at(-1)!;
    const webhook = await sendWebhook(
      ctx,
      checkoutCompletedEvent(ctx, {
        sessionId: session.result.id,
        reservationId,
        amount: session.input.amount,
      }),
    );
    expect(webhook.statusCode).toBe(200);

    const status = (await ctx.app.inject({
      method: "GET",
      url: `/api/reservations/${reservationId}`,
    })).json<ReservationStatusResponse>();
    expect(status.status).toBe("paid");
    expect(status.pointsUsed).toBe(1000);
    // 7900 gr = 79 pełnych złotych → 790 punktów.
    expect(status.pointsEarned).toBe(790);

    // Punkty za zakup dopisuje worker — do tego czasu saldo to 0.
    expect((await loyalty("anna@example.com")).json<LoyaltyResponse>().points).toBe(0);
    expect(await ctx.services.worker.runOnce()).toBe(true);
    expect((await loyalty("anna@example.com")).json<LoyaltyResponse>().points).toBe(790);

    // Kolejne przejście workera nie ma czego robić — punkty naliczone raz.
    expect(await ctx.services.worker.runOnce()).toBe(false);
    expect((await loyalty("anna@example.com")).json<LoyaltyResponse>().points).toBe(790);
  });

  it("odmawia, gdy punktów jest więcej niż połowa ceny albo więcej niż saldo", async () => {
    ctx = await createTestContext();
    const reservationId = await reserve();

    // Cena 8900 gr → maksimum 4450 punktów.
    const overHalf = await checkout(reservationId, 4451);
    expect(overHalf.statusCode).toBe(409);
    expect(overHalf.json()).toMatchObject({ error: "POINTS_LIMIT_EXCEEDED" });

    const overBalance = await checkout(reservationId, 4450);
    expect(overBalance.statusCode).toBe(409);
    expect(overBalance.json()).toMatchObject({ error: "INSUFFICIENT_POINTS" });

    expect(ctx.payments.sessions).toHaveLength(0);
    expect((await loyalty("anna@example.com")).json<LoyaltyResponse>().points).toBe(1000);
  });

  it("waliduje liczbę punktów w body", async () => {
    ctx = await createTestContext();
    const reservationId = await reserve();

    for (const points of [-1, 1.5, "100"]) {
      const response = await ctx.app.inject({
        method: "POST",
        url: `/api/reservations/${reservationId}/checkout`,
        headers: { "idempotency-key": newIdempotencyKey() },
        payload: { points },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: "VALIDATION_ERROR" });
    }
  });

  it("wygasła sesja oddaje użyte punkty, powtórka zdarzenia nie dubluje zwrotu", async () => {
    ctx = await createTestContext();
    const reservationId = await reserve();

    await checkout(reservationId, 1000);
    const session = ctx.payments.sessions.at(-1)!;
    expect((await loyalty("anna@example.com")).json<LoyaltyResponse>().points).toBe(0);

    const expired = {
      ...checkoutCompletedEvent(ctx, {
        sessionId: session.result.id,
        reservationId,
        amount: session.input.amount,
        paymentStatus: "unpaid",
      }),
      type: "checkout.session.expired",
    };
    const first = await sendWebhook(ctx, expired);
    expect(first.statusCode).toBe(200);
    expect((await loyalty("anna@example.com")).json<LoyaltyResponse>().points).toBe(1000);

    const replay = await sendWebhook(ctx, expired);
    expect(replay.statusCode).toBe(200);
    expect((await loyalty("anna@example.com")).json<LoyaltyResponse>().points).toBe(1000);
  });
});

describe("karta C — mail z podsumowaniem punktów", () => {
  it("mail zawiera kartę, punkty użyte i punkty zebrane", async () => {
    ctx = await createTestContext();
    const reservationId = await reserve();

    await checkout(reservationId, 1000);
    const session = ctx.payments.sessions.at(-1)!;
    await sendWebhook(
      ctx,
      checkoutCompletedEvent(ctx, {
        sessionId: session.result.id,
        reservationId,
        amount: session.input.amount,
      }),
    );

    expect(await ctx.services.worker.runOnce()).toBe(true);
    const text = ctx.mailer.calls[0]?.message.text ?? "";
    expect(text).toContain("Zapłacono kartą: 79,00 zł");
    expect(text).toContain("Zapłacono punktami: 1000 pkt (10,00 zł)");
    expect(text).toContain("Punkty za ten zakup: 790 pkt");
  });

  it("zakup bez punktów ma pełną kwotę i zero po stronie punktowej", async () => {
    ctx = await createTestContext();
    const reservationId = await reserve();

    const started = await checkout(reservationId);
    expect(started.statusCode).toBe(200);
    expect(ctx.payments.sessions.at(-1)?.input.amount).toBe(8900);

    const session = ctx.payments.sessions.at(-1)!;
    await sendWebhook(
      ctx,
      checkoutCompletedEvent(ctx, {
        sessionId: session.result.id,
        reservationId,
        amount: session.input.amount,
      }),
    );
    expect(await ctx.services.worker.runOnce()).toBe(true);
    const text = ctx.mailer.calls[0]?.message.text ?? "";
    expect(text).toContain("Zapłacono punktami: 0 pkt (0,00 zł)");
    expect(text).toContain("Punkty za ten zakup: 890 pkt");
  });
});
