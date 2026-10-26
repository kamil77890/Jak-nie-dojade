import { afterEach, describe, expect, it } from "vitest";
import {
  ttlMsFromEnv,
  type CreateReservationResponse,
  type EventDetailResponse,
  type PurchaseResponse,
} from "@pas/shared";
import { createTestContext, reservationPayload, type TestContext } from "./helpers";

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
});

const EVENT_URL = "/api/events/ic-7310-2026-11-21";
const TWO_MINUTES = 2 * 60_000;

/** Ten sam TTL co w testach akceptacyjnych: RESERVATION_TTL_MINUTES=2. */
async function createTwoMinuteContext() {
  ctx = await createTestContext({
    overrides: { ttlMs: ttlMsFromEnv({ RESERVATION_TTL_MINUTES: "2" }) },
  });
}

async function takenSeats(): Promise<string[]> {
  const response = await ctx.app.inject({ method: "GET", url: EVENT_URL });
  return response.json<EventDetailResponse>().takenSeats;
}

async function reserve() {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/reservations",
    payload: reservationPayload({ seatId: "5-12" }),
  });
  expect(response.statusCode).toBe(201);
  return response.json<CreateReservationResponse>();
}

function purchase(reservationId: string) {
  return ctx.app.inject({ method: "POST", url: `/api/reservations/${reservationId}/purchase` });
}

describe("E2E A → B → C przy TTL = 2 min", () => {
  it("happy path: mapa → rezerwacja → licznik → bilet", async () => {
    await createTwoMinuteContext();
    expect(await takenSeats()).not.toContain("5-12");

    const { reservationId, expiresAt } = await reserve();
    expect(Date.parse(expiresAt) - ctx.now()).toBe(TWO_MINUTES);
    expect(await takenSeats()).toContain("5-12");

    ctx.advance(TWO_MINUTES - 1_000);
    const first = await purchase(reservationId);
    expect(first.statusCode).toBe(200);
    const { code } = first.json<PurchaseResponse>();
    expect(code).toMatch(/^PAS-[A-Z2-9]{6}$/);

    // Podwójne kliknięcie zwraca ten sam kod.
    const second = await purchase(reservationId);
    expect(second.json<PurchaseResponse>().code).toBe(code);

    // Kupione miejsce zostaje zajęte także po upływie TTL.
    ctx.advance(TWO_MINUTES * 5);
    expect(await takenSeats()).toContain("5-12");
  });

  it("ścieżka wygaśnięcia: po 2 minutach brak biletu i miejsce wraca do puli", async () => {
    await createTwoMinuteContext();
    const { reservationId } = await reserve();

    ctx.advance(TWO_MINUTES);
    expect(await takenSeats()).not.toContain("5-12");

    const response = await purchase(reservationId);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "RESERVATION_EXPIRED" });

    // Ktoś inny może od razu zarezerwować to samo miejsce.
    const next = await reserve();
    expect(next.reservationId).not.toBe(reservationId);
  });
});
