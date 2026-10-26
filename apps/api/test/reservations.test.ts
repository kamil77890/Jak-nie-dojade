import { afterEach, describe, expect, it } from "vitest";
import type {
  CreateReservationResponse,
  EventDetailResponse,
  PurchaseResponse,
} from "@pas/shared";
import { createTestContext, reservationPayload, type TestContext } from "./helpers";

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
});

async function reserve(payload = reservationPayload()) {
  return ctx.app.inject({ method: "POST", url: "/api/reservations", payload });
}

describe("karta B — rezerwacja", () => {
  it("tworzy rezerwację, blokuje miejsce i liczy TTL od serwera", async () => {
    ctx = await createTestContext();
    const response = await reserve();

    expect(response.statusCode).toBe(201);
    const body = response.json<CreateReservationResponse>();
    expect(body.reservationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.expiresAt).toBe(
      new Date(ctx.now() + ctx.services.config.ttlMs).toISOString(),
    );

    const detail = await ctx.app.inject({
      method: "GET",
      url: "/api/events/ic-7310-2026-11-21",
    });
    expect(detail.json<EventDetailResponse>().takenSeats).toContain("5-1");
  });

  it("drugie zajęcie tego samego miejsca daje 409 SEAT_UNAVAILABLE", async () => {
    ctx = await createTestContext();
    expect((await reserve()).statusCode).toBe(201);

    const duplicate = await reserve(
      reservationPayload({ customerName: "Jan Nowak", email: "jan@example.com" }),
    );
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: "SEAT_UNAVAILABLE" });
  });

  it("powtórka identycznej rezerwacji też daje 409, a pierwsza rezerwacja zostaje", async () => {
    ctx = await createTestContext();
    const first = await reserve();
    const [second, third] = await Promise.all([reserve(), reserve()]);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect(third.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "SEAT_UNAVAILABLE" });

    const detail = await ctx.app.inject({ method: "GET", url: "/api/events/ic-7310-2026-11-21" });
    expect(detail.json<EventDetailResponse>().takenSeats.filter((seat) => seat === "5-1")).toHaveLength(1);
  });

  it("zły Content-Type i zły JSON to 4xx, nie 5xx", async () => {
    ctx = await createTestContext();
    const xml = await ctx.app.inject({
      method: "POST",
      url: "/api/reservations",
      headers: { "content-type": "application/xml" },
      payload: "<eventId>1</eventId>",
    });
    const broken = await ctx.app.inject({
      method: "POST",
      url: "/api/reservations",
      headers: { "content-type": "application/json" },
      payload: "{zly json",
    });
    expect(xml.statusCode).toBe(415);
    expect(broken.statusCode).toBe(400);
  });

  it("waliduje imię, e-mail i wymagane pola", async () => {
    ctx = await createTestContext();

    for (const payload of [
      reservationPayload({ customerName: "A" }),
      reservationPayload({ email: "nie-email" }),
      reservationPayload({ seatId: "" }),
      reservationPayload({ eventId: undefined }),
    ]) {
      const response = await reserve(payload);
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("VALIDATION_ERROR");
    }
  });

  it("zwraca 404 dla nieznanego kursu albo miejsca", async () => {
    ctx = await createTestContext();

    const missingEvent = await reserve(reservationPayload({ eventId: "nie-ma" }));
    expect(missingEvent.statusCode).toBe(404);
    expect(missingEvent.json()).toEqual({ error: "EVENT_OR_SEAT_NOT_FOUND" });

    const missingSeat = await reserve(reservationPayload({ seatId: "5-99" }));
    expect(missingSeat.statusCode).toBe(404);
    expect(missingSeat.json()).toEqual({ error: "EVENT_OR_SEAT_NOT_FOUND" });
  });

  it("po TTL miejsce wraca do puli, a zakup daje 409", async () => {
    ctx = await createTestContext();
    const created = await reserve();
    const { reservationId } = created.json<CreateReservationResponse>();

    ctx.advance(ctx.services.config.ttlMs + 1);

    const detail = await ctx.app.inject({
      method: "GET",
      url: "/api/events/ic-7310-2026-11-21",
    });
    expect(detail.json<EventDetailResponse>().takenSeats).not.toContain("5-1");

    const purchase = await ctx.app.inject({
      method: "POST",
      url: `/api/reservations/${reservationId}/purchase`,
    });
    expect(purchase.statusCode).toBe(409);
    expect(purchase.json()).toEqual({ error: "RESERVATION_EXPIRED" });

    const again = await reserve();
    expect(again.statusCode).toBe(201);
  });
});

describe("karta C — zakup", () => {
  it("zwraca kod biletu i nie tworzy drugiego kodu przy powtórce", async () => {
    ctx = await createTestContext();
    const created = await reserve();
    const { reservationId } = created.json<CreateReservationResponse>();

    const first = await ctx.app.inject({
      method: "POST",
      url: `/api/reservations/${reservationId}/purchase`,
    });
    expect(first.statusCode).toBe(200);
    const code = first.json<PurchaseResponse>().code;
    expect(code).toMatch(/^PAS-[A-Z2-9]{6}$/);

    const second = await ctx.app.inject({
      method: "POST",
      url: `/api/reservations/${reservationId}/purchase`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<PurchaseResponse>().code).toBe(code);
    expect(ctx.services.jobs.stats().total).toBe(1);
  });

  it("zakup enqueue'uje job e-mail w tej samej transakcji", async () => {
    ctx = await createTestContext();
    const created = await reserve();
    const { reservationId } = created.json<CreateReservationResponse>();

    await ctx.app.inject({
      method: "POST",
      url: `/api/reservations/${reservationId}/purchase`,
    });

    const jobs = ctx.services.jobs.list(10);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      task: "send-ticket-email",
      input: { reservationId },
      completedAt: null,
      hasError: false,
      totalTried: 0,
    });
  });

  it("dla nieistniejącej rezerwacji zwraca 404", async () => {
    ctx = await createTestContext();
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/reservations/00000000-0000-0000-0000-000000000000/purchase",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "RESERVATION_NOT_FOUND" });
  });
});
