// @vitest-environment node
import "./jsdom-node";
import { freezeDate, installDom, ticketField } from "./dom";
import { EVENTS, ttlMsFromEnv } from "@pas/shared";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestContext, type TestContext } from "../../api/test/helpers";
import { App } from "../src/App";

installDom();

/**
 * E2E przez prawdziwe ekrany i prawdziwe API: React w jsdom, a `fetch` trafia
 * w Fastify + SQLite w pamięci przez `inject`. Zegar API i `Date` w przeglądarce
 * są wspólne, więc wygaśnięcie z TTL = 2 min nie trwa 2 minut.
 */
const TWO_MINUTES = 2 * 60_000;
const event = EVENTS[0]!;

let ctx: TestContext;
let advance: (ms: number) => void;

beforeEach(async () => {
  ctx = await createTestContext({ overrides: { ttlMs: ttlMsFromEnv({ RESERVATION_TTL_MINUTES: "2" }) } });
  const advanceBrowser = freezeDate(ctx.now());
  advance = (ms) => {
    ctx.advance(ms);
    advanceBrowser(ms);
  };

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const response = await ctx.app.inject({
      method: (init?.method ?? "GET") as "GET" | "POST",
      url: `${url.pathname}${url.search}`,
      headers: init?.headers as Record<string, string> | undefined,
      ...(typeof init?.body === "string" ? { payload: init.body } : {}),
    });
    const headers = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined) headers.set(name, String(value));
    }
    return new Response(response.body || null, { status: response.statusCode, headers });
  });
});

afterEach(async () => {
  await ctx.close();
});

function seatButton(seatId: string): HTMLButtonElement {
  const [wagon, seat] = seatId.split("-");
  return screen.getByRole("button", {
    name: new RegExp(`^Wagon ${wagon}, miejsce ${seat},`),
  }) as HTMLButtonElement;
}

async function takenSeats(): Promise<string[]> {
  const response = await ctx.app.inject({ method: "GET", url: `/api/events/${event.id}` });
  return response.json<{ takenSeats: string[] }>().takenSeats;
}

/** A → B: z rozkładu przez mapę wagonu do formularza i licznika. */
async function reserveSeat(seatId: string): Promise<void> {
  const { container } = render(
    <MemoryRouter initialEntries={["/"]}>
      <App />
    </MemoryRouter>,
  );

  // Karta A: lista kursów z API.
  await waitFor(() => expect(container.querySelector(`a[href="/events/${event.id}"]`)).not.toBeNull());
  fireEvent.click(container.querySelector(`a[href="/events/${event.id}"]`)!);

  // Mapa wagonu: przełącznik wagonów i wolne miejsce.
  const wagons = await screen.findByRole("tablist", { name: "Wybierz wagon" });
  fireEvent.click(within(wagons).getByRole("tab", { name: /Wagon 6/ }));
  expect(seatButton("6-1")).toBeTruthy();
  fireEvent.click(within(wagons).getByRole("tab", { name: /Wagon 5/ }));
  fireEvent.click(seatButton(seatId));

  // Karta B: formularz z etykietą miejsca i TTL z serwera.
  await screen.findByLabelText("Imię i nazwisko");
  expect(container.querySelector(".form-card-seat")?.textContent).toBe("Wagon 5, miejsce 12");
  fireEvent.change(screen.getByLabelText("Imię i nazwisko"), { target: { value: "Anna Kowalska" } });
  fireEvent.change(screen.getByLabelText("Adres e-mail"), { target: { value: "anna@example.com" } });
  fireEvent.click(await screen.findByRole("button", { name: /Rezerwuję na 2 minuty/ }));

  // Ekran licznika liczy od expiresAt z serwera.
  const timer = await screen.findByRole("timer");
  expect(timer.textContent).toBe("02:00");
}

describe("E2E A → B → C przez ekrany, TTL = 2 min", () => {
  it("happy path: rozkład → mapa → formularz → licznik → bilet", async () => {
    await reserveSeat("5-12");
    expect(await takenSeats()).toEqual(["5-12"]);

    advance(TWO_MINUTES - 5_000);
    await waitFor(() => expect(screen.getByRole("timer").textContent).toBe("00:05"));

    fireEvent.click(screen.getByRole("button", { name: /Kupuję bilet/ }));

    const ticket = await screen.findByLabelText(/^Bilet PAS-[A-HJ-NP-Z2-9]{6}$/);
    expect(within(ticket).getByText(event.relation)).toBeTruthy();
    expect(within(ticket).getByText("21 listopada 2026")).toBeTruthy();
    expect(within(ticket).getByText(event.departureTime)).toBeTruthy();
    expect(within(ticket).getByText(event.arrivalTime)).toBeTruthy();
    expect(ticketField(ticket, "Miejsce")).toBe("Wagon 5, miejsce 12");

    // Kupione miejsce zostaje zajęte także po TTL.
    advance(TWO_MINUTES * 5);
    expect(await takenSeats()).toEqual(["5-12"]);
  });

  it("wygaśnięcie: licznik dochodzi do zera, brak biletu, miejsce wraca na mapę", async () => {
    await reserveSeat("5-12");

    advance(TWO_MINUTES);

    expect(await screen.findAllByText(/Rezerwacja wygasła — miejsce wróciło do puli/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Kupuję bilet/ })).toBeNull();
    expect(await takenSeats()).toEqual([]);

    fireEvent.click(screen.getByRole("link", { name: "Mapa wagonu" }));
    await waitFor(() => expect(seatButton("5-12").getAttribute("aria-label")).toMatch(/wolne$/));
    expect(seatButton("5-12").disabled).toBe(false);
  });

  it("serwer decyduje: 409 RESERVATION_EXPIRED przy zakupie, choć licznik w przeglądarce jeszcze trwa", async () => {
    await reserveSeat("5-12");

    // Tylko zegar API idzie do przodu — przeglądarka nadal widzi 02:00.
    ctx.advance(TWO_MINUTES);
    fireEvent.click(screen.getByRole("button", { name: /Kupuję bilet/ }));

    expect(await screen.findAllByText(/Rezerwacja wygasła — miejsce wróciło do puli/)).toBeTruthy();
    expect(screen.getByRole("timer").textContent).toBe("00:00");
    expect(screen.queryByLabelText(/^Bilet PAS-/)).toBeNull();
    expect(await takenSeats()).toEqual([]);
  });
});
