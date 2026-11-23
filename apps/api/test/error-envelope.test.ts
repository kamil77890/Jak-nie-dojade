import { afterEach, describe, expect, it } from "vitest";
import type { ApiError } from "@pas/shared";
import { LoyaltyProviderError, type LoyaltyProvider } from "../src/loyalty";
import { createTestContext, newIdempotencyKey, reservationPayload, type TestContext } from "./helpers";
import { seedAccount } from "./loyalty-helpers";

/**
 * Koperta błędu: `{ error, message, retryAfter? }`. Kod jest dla programu,
 * komunikat po polsku dla człowieka — i nigdy nie niesie przyczyny technicznej.
 */
let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
});

const brokenVoucherify: LoyaltyProvider = {
  name: "voucherify",
  createMember: async () => {
    throw new LoyaltyProviderError("Voucherify 500: stack trace z sekretem", true);
  },
  getBalance: async () => {
    throw new LoyaltyProviderError("Voucherify 500: stack trace z sekretem", true);
  },
  adjustPoints: async () => {
    throw new LoyaltyProviderError("Voucherify 500: stack trace z sekretem", true);
  },
};

describe("koperta błędu API", () => {
  it("4xx niesie konkretny komunikat odmowy po polsku", async () => {
    ctx = await createTestContext();

    const missing = await ctx.app.inject({ method: "GET", url: "/api/reservations/nie-ma-takiej" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "RESERVATION_NOT_FOUND", message: "Nie znaleziono rezerwacji." });

    const badEmail = await ctx.app.inject({
      method: "POST",
      url: "/api/reservations",
      payload: reservationPayload({ email: "to-nie-mail" }),
    });
    expect(badEmail.statusCode).toBe(400);
    expect(badEmail.json()).toEqual({ error: "VALIDATION_ERROR", message: "Podaj poprawny adres e-mail." });

    const created = await ctx.app.inject({ method: "POST", url: "/api/reservations", payload: reservationPayload() });
    expect(created.statusCode).toBe(201);
    const { reservationId } = created.json<{ reservationId: string }>();

    const tooManyPoints = await ctx.app.inject({
      method: "POST",
      url: `/api/reservations/${reservationId}/checkout`,
      headers: { "idempotency-key": newIdempotencyKey() },
      payload: { points: 999_999 },
    });
    expect(tooManyPoints.statusCode).toBe(409);
    expect(tooManyPoints.json()).toEqual({
      error: "POINTS_LIMIT_EXCEEDED",
      message: "Punktami można zapłacić najwyżej połowę ceny biletu.",
    });
  });

  it("błędy Fastify (zły JSON) i nieznana trasa mają stały komunikat bez szczegółów parsera", async () => {
    ctx = await createTestContext();

    const brokenJson = await ctx.app.inject({
      method: "POST",
      url: "/api/reservations",
      headers: { "content-type": "application/json" },
      payload: "{ to nie jest json",
    });
    expect(brokenJson.statusCode).toBe(400);
    expect(brokenJson.json()).toEqual({ error: "VALIDATION_ERROR", message: "Nieprawidłowe dane wejściowe." });

    const unknownRoute = await ctx.app.inject({ method: "GET", url: "/api/nie-ma-takiej-trasy" });
    expect(unknownRoute.statusCode).toBe(404);
    expect(unknownRoute.json()).toEqual({ error: "NOT_FOUND", message: "Nie znaleziono zasobu." });
  });

  it("5xx ma ogólny komunikat i Retry-After, a przyczyna z Voucherify nie trafia do klienta", async () => {
    ctx = await createTestContext({ loyaltyProvider: brokenVoucherify });
    seedAccount(ctx, "anna@example.com", "CARD-anna");

    const response = await ctx.app.inject({ method: "GET", url: "/api/loyalty?email=anna@example.com" });
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("5");
    const body = response.json<ApiError>();
    expect(body).toEqual({
      error: "LOYALTY_UNAVAILABLE",
      message: "Program lojalnościowy chwilowo nie działa. Spróbuj za chwilę.",
      retryAfter: 5,
    });
    expect(response.body).not.toContain("sekret");
    expect(response.body).not.toContain("Voucherify");
  });
});
