import { afterEach, describe, expect, it } from "vitest";
import { EVENTS } from "@pas/shared";
import { createTestContext, reservationPayload, type TestContext } from "./helpers";

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
});

/** Wszystkie miejsca ze wszystkich kursów — 3 × 2 × 20 = 120. */
const ALL_SEATS = EVENTS.flatMap((event) =>
  event.wagons.flatMap((wagon) => wagon.seats.map((seat) => ({ eventId: event.id, seatId: seat.id }))),
);

/** Domyślne limity z config.ts, jak na wdrożeniu. */
async function withDefaultLimits(): Promise<TestContext> {
  return createTestContext({ overrides: { rateLimit: { enabled: true } } });
}

function reserve(context: TestContext, payload: Record<string, unknown>, remoteAddress?: string) {
  return context.app.inject({
    method: "POST",
    url: "/api/reservations",
    payload,
    ...(remoteAddress ? { remoteAddress } : {}),
  });
}

describe("test chaosu — limit rezerwacji przy szybkim przebiegu z jednego IP", () => {
  it("B3 + B1 + B2, a potem rezerwacje pod C/A/B4 nie dostają 429", async () => {
    ctx = await withDefaultLimits();
    const statuses: number[] = [];

    // B3: nieistniejące wydarzenie i miejsce (404 zużywa żeton), puste imię i e-mail
    // (400 oddaje żeton), każde dwa razy — zegar stoi, więc to najgorszy przypadek.
    const bad = [
      reservationPayload({ eventId: "nie-ma-takiego" }),
      reservationPayload({ seatId: "9-99" }),
      reservationPayload({ customerName: "" }),
      reservationPayload({ email: "" }),
    ];
    for (let i = 0; i < 8; i += 1) {
      const response = await reserve(ctx, bad[i % bad.length]!);
      expect([400, 404]).toContain(response.statusCode);
    }

    // B1: identyczny POST 2× po kolei i 2× równolegle.
    const b1 = reservationPayload({ seatId: "5-1" });
    statuses.push((await reserve(ctx, b1)).statusCode, (await reserve(ctx, b1)).statusCode);
    const parallelB1 = await Promise.all([reserve(ctx, b1), reserve(ctx, b1)]);
    statuses.push(...parallelB1.map((response) => response.statusCode));
    expect(statuses).toEqual([201, 200, 200, 200]);

    // B2: 20 równoczesnych rezerwacji jednego miejsca — dokładnie jedna 2xx.
    const b2 = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        reserve(ctx, reservationPayload({ seatId: "5-2", customerName: `Klient ${i}`, email: `k${i}@example.com` })),
      ),
    );
    const b2Codes = b2.map((response) => response.statusCode);
    expect(b2Codes.filter((code) => code >= 200 && code < 300)).toHaveLength(1);
    expect(b2Codes.filter((code) => code === 409)).toHaveLength(19);

    // Przygotowanie C1, C2, C4, A2, B4 — 10 kolejnych rezerwacji bez czekania.
    // Kolejne rundy C2 czekają na wygaśnięcie, więc limit zdąży się odbudować.
    for (const seat of ALL_SEATS.slice(10, 20)) {
      const response = await reserve(ctx, reservationPayload(seat));
      expect(response.statusCode).toBe(201);
    }
    expect(ctx.services.guards.rateLimited).toBe(0);
  });
});

describe("test chaosu — B5: zalew rezerwacji od jednego klienta", () => {
  it("100 rezerwacji w 10 s: po limicie 429 z Retry-After, bez 5xx; inny klient rezerwuje", async () => {
    ctx = await withDefaultLimits();
    const codes: number[] = [];

    for (const seat of ALL_SEATS.slice(0, 100)) {
      const response = await reserve(ctx, reservationPayload(seat), "198.51.100.1");
      codes.push(response.statusCode);
      if (response.statusCode === 429) {
        expect(Number(response.headers["retry-after"])).toBeGreaterThanOrEqual(1);
        expect(response.json()).toMatchObject({ error: "RATE_LIMITED" });
      }
      ctx.advance(100);
    }

    expect(codes.filter((code) => code >= 500)).toHaveLength(0);
    expect(codes.slice(0, 40).every((code) => code === 201)).toBe(true);
    expect(codes.filter((code) => code === 429).length).toBeGreaterThanOrEqual(15);

    const other = await reserve(ctx, reservationPayload(ALL_SEATS[110]!), "203.0.113.50");
    expect(other.statusCode).toBe(201);
  });

  it("409 na zajętym miejscu zużywa żeton, więc zalew zajętych miejsc też dostaje 429", async () => {
    ctx = await createTestContext({
      overrides: {
        rateLimit: {
          enabled: true,
          global: { capacity: 1_000, refillPerSecond: 0 },
          reservation: { capacity: 3, refillPerSecond: 0 },
          purchase: { capacity: 10, refillPerSecond: 0 },
        },
      },
    });

    expect((await reserve(ctx, reservationPayload())).statusCode).toBe(201);
    const other = reservationPayload({ customerName: "Jan Nowak", email: "jan@example.com" });
    expect((await reserve(ctx, other)).statusCode).toBe(409);
    expect((await reserve(ctx, other)).statusCode).toBe(409);
    expect((await reserve(ctx, other)).statusCode).toBe(429);
  });

  it("400 oddaje żeton, więc złe requesty nie blokują poprawnej rezerwacji", async () => {
    ctx = await createTestContext({
      overrides: {
        rateLimit: {
          enabled: true,
          global: { capacity: 1_000, refillPerSecond: 0 },
          reservation: { capacity: 1, refillPerSecond: 0 },
          purchase: { capacity: 10, refillPerSecond: 0 },
        },
      },
    });

    for (let i = 0; i < 5; i += 1) {
      expect((await reserve(ctx, reservationPayload({ customerName: "" }))).statusCode).toBe(400);
    }
    expect((await reserve(ctx, reservationPayload())).statusCode).toBe(201);
    expect((await reserve(ctx, reservationPayload({ seatId: "5-2" }))).statusCode).toBe(429);
  });

  it("zalew nieistniejących miejsc (404) dostaje 429, bo 404 nie oddaje żetonu", async () => {
    ctx = await createTestContext({
      overrides: {
        rateLimit: {
          enabled: true,
          global: { capacity: 1_000, refillPerSecond: 0 },
          reservation: { capacity: 3, refillPerSecond: 0 },
          purchase: { capacity: 10, refillPerSecond: 0 },
        },
      },
    });

    const statuses: number[] = [];
    for (let seat = 21; seat <= 26; seat += 1) {
      statuses.push((await reserve(ctx, reservationPayload({ seatId: `5-${seat}` }))).statusCode);
    }
    expect(statuses).toEqual([404, 404, 404, 429, 429, 429]);
  });

  it("zakodowana ścieżka /%61pi nie omija globalnego limitu", async () => {
    ctx = await createTestContext({
      overrides: {
        rateLimit: {
          enabled: true,
          global: { capacity: 2, refillPerSecond: 0 },
          reservation: { capacity: 100, refillPerSecond: 0 },
          purchase: { capacity: 100, refillPerSecond: 0 },
        },
      },
    });

    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      statuses.push((await ctx.app.inject({ method: "GET", url: "/%61pi/events" })).statusCode);
    }
    expect(statuses[2]).toBe(429);
  });
});

describe("TRUST_PROXY jako liczba hopów", () => {
  it("przy TRUST_PROXY=1 podrobiony X-Forwarded-For nie obchodzi limitu", async () => {
    ctx = await createTestContext({
      overrides: {
        trustProxy: 1,
        rateLimit: {
          enabled: true,
          global: { capacity: 1_000, refillPerSecond: 0 },
          reservation: { capacity: 2, refillPerSecond: 0 },
          purchase: { capacity: 10, refillPerSecond: 0 },
        },
      },
    });

    // Proxy (127.0.0.1) dopisuje prawdziwe IP klienta na końcu nagłówka;
    // wszystko na lewo pochodzi od klienta i może być podrobione.
    const fromAttacker = (seatId: string, spoofed: string) =>
      ctx.app.inject({
        method: "POST",
        url: "/api/reservations",
        payload: reservationPayload({ seatId }),
        remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": `${spoofed}, 198.51.100.7` },
      });

    expect((await fromAttacker("5-1", "10.0.0.1")).statusCode).toBe(201);
    expect((await fromAttacker("5-2", "10.0.0.2")).statusCode).toBe(201);
    const limited = await fromAttacker("5-3", "10.0.0.3");
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();

    // Inny klient za tym samym proxy ma własny limit.
    const otherClient = await ctx.app.inject({
      method: "POST",
      url: "/api/reservations",
      payload: reservationPayload({ seatId: "5-4" }),
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "198.51.100.8" },
    });
    expect(otherClient.statusCode).toBe(201);
  });
});
