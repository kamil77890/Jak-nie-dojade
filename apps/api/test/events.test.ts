import { afterEach, describe, expect, it } from "vitest";
import type { EventDetailResponse, EventListItem, EventSummary } from "@pas/shared";
import { createTestContext, reservationPayload, type TestContext } from "./helpers";

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
});

describe("karta A — wydarzenia i mapa", () => {
  it("zwraca trzy kursy w formie summary", async () => {
    ctx = await createTestContext();
    const response = await ctx.app.inject({ method: "GET", url: "/api/events" });

    expect(response.statusCode).toBe(200);
    const events = response.json<EventSummary[]>();
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      id: "ic-7310-2026-11-21",
      relation: "Warszawa Wschodnia → Kraków Główny",
      departureTime: "08:10",
    });
    expect(events[0]).not.toHaveProperty("wagons");
  });

  it("liczy wagony, miejsca i wolne miejsca z tego samego store'u co takenSeats", async () => {
    ctx = await createTestContext();
    const list = async () =>
      (await ctx.app.inject({ method: "GET", url: "/api/events" })).json<EventListItem[]>()[0]!;

    expect(await list()).toMatchObject({ wagonCount: 2, seatCount: 40, freeSeats: 40 });

    await ctx.app.inject({ method: "POST", url: "/api/reservations", payload: reservationPayload() });
    expect((await list()).freeSeats).toBe(39);

    ctx.advance(ctx.services.config.ttlMs);
    expect((await list()).freeSeats).toBe(40);
  });

  it("zwraca event z wagonami i pustą listą zajętych miejsc", async () => {
    ctx = await createTestContext();
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/events/ic-7310-2026-11-21",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<EventDetailResponse>();
    expect(body.event.wagons).toHaveLength(2);
    expect(body.event.wagons[0]?.seats).toHaveLength(20);
    expect(body.event.wagons[1]?.number).toBe(6);
    expect(body.takenSeats).toEqual([]);
  });

  it("dla nieznanego kursu zwraca 404 EVENT_NOT_FOUND", async () => {
    ctx = await createTestContext();
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/events/nie-ma-takiego",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "EVENT_NOT_FOUND" });
  });
});
