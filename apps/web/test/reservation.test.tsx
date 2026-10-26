// @vitest-environment jsdom
import { freezeDate, installDom, json, ticketField } from "./dom";
import { EVENTS, EVENT_SUMMARIES, type ReservationView } from "@pas/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { saveReservation, saveTicket } from "../src/lib/session";

installDom();

const event = EVENTS[0]!;
const NOW = Date.parse("2026-11-01T09:00:00.000Z");
const TWO_MINUTES = 2 * 60_000;

type Handler = (method: string, path: string, body: unknown) => Response | Promise<Response>;

/** Zaślepka API zgodna z kontraktem; /api/health zwraca tryb testowy prowadzącego. */
function stubApi(handler: Handler = () => json(404, { error: "NOT_FOUND" })) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (path === "/api/health") return json(200, { ok: true, reservationTtlSeconds: 120 });
    return handler(method, path, body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function eventDetail(takenSeats: string[] = []) {
  return json(200, { event, takenSeats });
}

function renderAt(path: string, state?: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: path, state }]}>
      <App />
    </MemoryRouter>,
  );
}

function view(overrides: Partial<ReservationView> = {}): ReservationView {
  return {
    reservationId: "res-1",
    expiresAt: new Date(NOW + TWO_MINUTES).toISOString(),
    event: EVENT_SUMMARIES[0]!,
    seatId: "5-12",
    customerName: "Anna Kowalska",
    email: "anna@example.com",
    ...overrides,
  };
}

const reservePath = `/events/${event.id}/reserve/5-12`;
const purchaseButton = () => screen.queryByRole("button", { name: /Kupuję bilet/ });

describe("karta A — lista kursów", () => {
  it("wagony, miejsca i wolne miejsca bierze z API; pełny kurs jest „wyprzedane”", async () => {
    stubApi((_method, path) =>
      path === "/api/events"
        ? json(200, [
            { ...EVENT_SUMMARIES[0]!, wagonCount: 3, seatCount: 60, freeSeats: 22 },
            { ...EVENT_SUMMARIES[1]!, wagonCount: 1, seatCount: 20, freeSeats: 0 },
          ])
        : json(404, { error: "NOT_FOUND" }),
    );
    const { container } = renderAt("/");

    await screen.findByText("22 wolne");
    const metas = [...container.querySelectorAll(".event-meta")].map((meta) => meta.textContent);
    expect(metas).toEqual(["3 wagony60 miejsc22 wolne", "1 wagon20 miejscwyprzedane"]);
    expect(container.querySelector(".section-meta")?.textContent).toBe("2 połączenia · 80 miejsc");
  });
});

describe("karta B — formularz rezerwacji", () => {
  it("pokazuje dokładnie „Wagon 5, miejsce 12” i TTL z serwera", async () => {
    stubApi((method, path) => (path === `/api/events/${event.id}` ? eventDetail() : json(404, {})));
    const { container } = renderAt(reservePath);

    await screen.findByLabelText("Imię i nazwisko");
    expect(container.querySelector(".form-card-seat")?.textContent).toBe("Wagon 5, miejsce 12");
    expect(await screen.findByRole("button", { name: /Rezerwuję na 2 minuty/ })).toBeTruthy();
    expect(screen.getByText(/Rezerwacja jest ważna 2 minuty/)).toBeTruthy();
  });

  it("waliduje imię i e-mail bez wysyłania requestu", async () => {
    const fetchMock = stubApi((method, path) =>
      path === `/api/events/${event.id}` ? eventDetail() : json(500, {}),
    );
    renderAt(reservePath);

    fireEvent.change(await screen.findByLabelText("Imię i nazwisko"), { target: { value: "A" } });
    fireEvent.change(screen.getByLabelText("Adres e-mail"), { target: { value: "anna@" } });
    fireEvent.click(screen.getByRole("button", { name: /Rezerwuję na/ }));

    expect(await screen.findByText("Podaj imię i nazwisko — co najmniej 2 znaki.")).toBeTruthy();
    expect(screen.getByText("Podaj poprawny adres e-mail, np. anna@example.com.")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("409 z API pokazuje czytelny błąd zajętego miejsca", async () => {
    stubApi((method, path) => {
      if (path === `/api/events/${event.id}`) return eventDetail();
      if (method === "POST" && path === "/api/reservations") return json(409, { error: "SEAT_UNAVAILABLE" });
      return json(404, {});
    });
    renderAt(reservePath);

    fireEvent.change(await screen.findByLabelText("Imię i nazwisko"), { target: { value: "Anna Kowalska" } });
    fireEvent.change(screen.getByLabelText("Adres e-mail"), { target: { value: "anna@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Rezerwuję na/ }));

    expect(await screen.findByText("Ktoś był szybszy — to miejsce właśnie zniknęło z mapy.")).toBeTruthy();
  });

  it("zajęte miejsce z takenSeats nie pokazuje formularza", async () => {
    stubApi((method, path) => (path === `/api/events/${event.id}` ? eventDetail(["5-12"]) : json(404, {})));
    renderAt(reservePath);

    expect(await screen.findByText("To miejsce jest już zajęte")).toBeTruthy();
    expect(screen.queryByLabelText("Imię i nazwisko")).toBeNull();
  });

  it("sukces wysyła kontrakt, zapisuje ReservationView i otwiera licznik", async () => {
    freezeDate(NOW);
    let sent: unknown;
    stubApi((method, path, body) => {
      if (path === `/api/events/${event.id}`) return eventDetail();
      if (method === "POST" && path === "/api/reservations") {
        sent = body;
        return json(201, { reservationId: "res-1", expiresAt: new Date(NOW + TWO_MINUTES).toISOString() });
      }
      return json(404, {});
    });
    renderAt(reservePath);

    fireEvent.change(await screen.findByLabelText("Imię i nazwisko"), { target: { value: " Anna Kowalska " } });
    fireEvent.change(screen.getByLabelText("Adres e-mail"), { target: { value: "Anna@Example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Rezerwuję na/ }));

    expect((await screen.findByRole("timer")).textContent).toBe("02:00");
    expect(sent).toEqual({
      eventId: event.id,
      seatId: "5-12",
      customerName: "Anna Kowalska",
      email: "anna@example.com",
    });
    const stored = JSON.parse(window.sessionStorage.getItem("pas.reservation.res-1") ?? "null");
    expect(stored).toMatchObject({ reservationId: "res-1", seatId: "5-12", event: { id: event.id } });
  });
});

describe("karta B — licznik", () => {
  it("liczy od expiresAt z serwera i działa po odświeżeniu (sessionStorage)", async () => {
    const advance = freezeDate(NOW + 28_000);
    stubApi();
    saveReservation(view());
    // Bez location.state — jak po odświeżeniu strony.
    renderAt("/reservations/res-1");

    expect(screen.getByRole("timer").textContent).toBe("01:32");
    expect(purchaseButton()).toBeTruthy();

    advance(60_000);
    await waitFor(() => expect(screen.getByRole("timer").textContent).toBe("00:32"));
  });

  it("przy zerze pokazuje wygaśnięcie i blokuje zakup", async () => {
    const advance = freezeDate(NOW);
    stubApi();
    saveReservation(view());
    renderAt("/reservations/res-1");

    advance(TWO_MINUTES);

    expect(await screen.findAllByText(/Rezerwacja wygasła — miejsce wróciło do puli/)).toBeTruthy();
    expect(screen.getByRole("timer").textContent).toBe("00:00");
    expect(purchaseButton()).toBeNull();
    expect((screen.getByRole("button", { name: /Rezerwacja wygasła/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("bez danych w sessionStorage mówi, że karta nie zna rezerwacji", () => {
    stubApi();
    renderAt("/reservations/nieznana");
    expect(screen.getByText("Ta karta nie pamięta rezerwacji")).toBeTruthy();
  });

  it("po zakupie (np. „Wstecz” z biletu) nie proponuje ponownego zakupu", () => {
    freezeDate(NOW);
    stubApi();
    saveReservation(view());
    saveTicket({ ...view(), code: "PAS-7K2M9Q", issuedAt: new Date(NOW).toISOString() });
    renderAt("/reservations/res-1");

    expect(screen.getByText("Bilet jest już kupiony")).toBeTruthy();
    expect(screen.getByText(/PAS-7K2M9Q/)).toBeTruthy();
    expect(purchaseButton()).toBeNull();
    expect(screen.queryByRole("timer")).toBeNull();
  });
});

describe("karta C — przycisk zakupu na ekranie B", () => {
  it("blokuje przycisk w trakcie requestu, a sukces otwiera bilet z kodem", async () => {
    freezeDate(NOW);
    let release: (response: Response) => void = () => undefined;
    stubApi((method, path) =>
      method === "POST" && path === "/api/reservations/res-1/purchase"
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : json(404, {}),
    );
    saveReservation(view());
    renderAt("/reservations/res-1");

    const button = purchaseButton() as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(button.textContent).toContain("Wydajemy bilet");

    release(json(200, { code: "PAS-7K2M9Q" }));

    const ticket = await screen.findByLabelText("Bilet PAS-7K2M9Q");
    expect(ticketField(ticket, "Miejsce")).toBe("Wagon 5, miejsce 12");
  });

  it("409 RESERVATION_EXPIRED: cały ekran przechodzi w wygaśnięcie, choć licznik jeszcze trwał", async () => {
    freezeDate(NOW);
    stubApi((method, path) =>
      method === "POST" && path === "/api/reservations/res-1/purchase"
        ? json(409, { error: "RESERVATION_EXPIRED" })
        : json(404, {}),
    );
    saveReservation(view());
    renderAt("/reservations/res-1");

    fireEvent.click(purchaseButton()!);

    expect(await screen.findAllByText(/Rezerwacja wygasła — miejsce wróciło do puli/)).toBeTruthy();
    expect(screen.getByRole("timer").textContent).toBe("00:00");
    expect(screen.queryByText(/czeka na Ciebie/)).toBeNull();
    expect(purchaseButton()).toBeNull();
    expect(window.sessionStorage.getItem("pas.ticket.res-1")).toBeNull();
  });
});
