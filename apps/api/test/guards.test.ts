import { afterEach, describe, expect, it } from "vitest";
import type { OpsStatus } from "@pas/shared";
import type { MailAdmin } from "../src/mail";
import { createTestContext, reservationPayload, type TestContext } from "./helpers";

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
});

describe("rate limiting — E05", () => {
  it("limit rezerwacji zwraca 429 z Retry-After", async () => {
    ctx = await createTestContext({
      overrides: {
        rateLimit: {
          enabled: true,
          global: { capacity: 1_000, refillPerSecond: 0 },
          reservation: { capacity: 2, refillPerSecond: 0 },
          purchase: { capacity: 100, refillPerSecond: 0 },
        },
      },
    });

    for (const seatId of ["5-1", "5-2"]) {
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/reservations",
        payload: reservationPayload({ seatId }),
      });
      expect(response.statusCode).toBe(201);
    }

    const limited = await ctx.app.inject({
      method: "POST",
      url: "/api/reservations",
      payload: reservationPayload({ seatId: "5-3" }),
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: "RATE_LIMITED" });
    expect(limited.headers["retry-after"]).toBe("60");
    expect(ctx.services.guards.rateLimited).toBe(1);
  });

  it("globalny limit obejmuje wszystkie endpointy API", async () => {
    ctx = await createTestContext({
      overrides: {
        rateLimit: {
          enabled: true,
          global: { capacity: 2, refillPerSecond: 0 },
          reservation: { capacity: 10, refillPerSecond: 0 },
          purchase: { capacity: 10, refillPerSecond: 0 },
        },
      },
    });

    expect((await ctx.app.inject({ method: "GET", url: "/api/events" })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/api/events" })).statusCode).toBe(200);

    const limited = await ctx.app.inject({ method: "GET", url: "/api/events" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe("RATE_LIMITED");
  });
});

describe("load shedding — E05", () => {
  it("przy przekroczeniu pojemności szybko zwraca 503 OVERLOADED", async () => {
    ctx = await createTestContext({ overrides: { overload: { maxInFlight: 0 } } });

    const response = await ctx.app.inject({ method: "GET", url: "/api/events" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "OVERLOADED", retryAfter: 5 });
    expect(response.headers["retry-after"]).toBe("5");
    expect(ctx.services.guards.loadShedRejected).toBe(1);
  });

  it("healthcheck nie jest zrzucany, gdy kasa jest przeciążona", async () => {
    ctx = await createTestContext({ overrides: { overload: { maxInFlight: 0 } } });

    const response = await ctx.app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
  });
});

describe("panel /lab — E04–E06", () => {
  it("pokazuje stan kolejki, bezpiecznika i pul", async () => {
    const mailAdmin = {
      control: async () => ({
        mode: "healthy",
        sent: 2,
        lastModeChangeAt: "2026-11-01T09:00:00.000Z",
      }),
      messages: async () => [],
      setMode: async () => null,
      reset: async () => true,
    } as unknown as MailAdmin;

    ctx = await createTestContext({ mailAdmin });
    const response = await ctx.app.inject({ method: "GET", url: "/api/ops/status" });

    expect(response.statusCode).toBe(200);
    const status = response.json<OpsStatus>();
    expect(status.mail).toMatchObject({ available: true, mode: "healthy", sent: 2 });
    expect(status.queue).toMatchObject({ ready: 0, done: 0, dlq: 0 });
    expect(status.breaker.state).toBe("closed");
    expect(status.guards.writePool.concurrency).toBe(8);
    expect(status.config.ttlSeconds).toBe(900);
  });

  it("nie wystawia panelu, gdy OPS_ENABLED=false", async () => {
    ctx = await createTestContext({ overrides: { opsEnabled: false } });
    const response = await ctx.app.inject({ method: "GET", url: "/api/ops/status" });
    expect(response.statusCode).toBe(404);
  });
});
