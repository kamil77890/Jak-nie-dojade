// @vitest-environment jsdom
import { freezeDate, installDom, json, ticketField } from "./dom";
import { EVENTS, EVENT_SUMMARIES, type ReservationView } from "@pas/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { redirectTo } from "../src/components/PurchasePanel";
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
    amount: 8900,
    ...overrides,
  };
}

const reservePath = `/events/${event.id}/reserve/5-12`;
const payButton = () => screen.queryByRole("button", { name: /^Zapłać/ });

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
    expect(metas).toEqual(["89 zł3 wagony60 miejsc22 wolne", "89 zł1 wagon20 miejscwyprzedane"]);
    expect(container.querySelector(".section-meta")?.textContent).toBe("2 połączenia · 80 miejsc");
  });
});

describe("karta B — formularz rezerwacji", () => {
  it("pokazuje dokładnie „Wagon 5, miejsce 12” i TTL z serwera", async () => {
    stubApi((method, path) => (path === `/api/events/${event.id}` ? eventDetail() : json(404, {})));
    const { container } = renderAt(reservePath);

    await screen.findByLabelText("Imię i nazwisko");
    expect(container.querySelector(".form-card-seat")?.textContent).toBe("Wagon 5, miejsce 12 · 89 zł");
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
        return json(201, {
          reservationId: "res-1",
          expiresAt: new Date(NOW + TWO_MINUTES).toISOString(),
          amount: 8900,
        });
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
    expect(stored).toMatchObject({ reservationId: "res-1", seatId: "5-12", amount: 8900, event: { id: event.id } });
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
    expect(payButton()).toBeTruthy();

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
    expect(payButton()).toBeNull();
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
    expect(payButton()).toBeNull();
    expect(screen.queryByRole("timer")).toBeNull();
  });
});

describe("karta A — przycisk „Zapłać” na ekranie rezerwacji", () => {
  it("wysyła Idempotency-Key, blokuje przycisk i przekierowuje na stronę Stripe'a", async () => {
    freezeDate(NOW);
    const assign = vi.spyOn(redirectTo, "assign").mockImplementation(() => undefined);
    let release: (response: Response) => void = () => undefined;
    const fetchMock = stubApi((method, path) =>
      method === "POST" && path === "/api/reservations/res-1/checkout"
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : json(404, {}),
    );
    saveReservation(view());
    renderAt("/reservations/res-1");

    const button = payButton() as HTMLButtonElement;
    expect(button.textContent).toContain("Zapłać 89 zł");
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(button.textContent).toContain("Przechodzimy do płatności");

    release(json(200, { url: "https://checkout.stripe.com/c/pay/cs_test_1" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test_1"));

    const checkoutCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/checkout"));
    const headers = checkoutCall?.[1]?.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    // Ten sam klucz zostaje w sesji — ponowna próba trafi w tę samą sesję Stripe'a.
    expect(window.sessionStorage.getItem("pas.checkout-key.res-1")).toBe(JSON.stringify(headers["idempotency-key"]));
  });

  it("409 RESERVATION_EXPIRED: cały ekran przechodzi w wygaśnięcie, choć licznik jeszcze trwał", async () => {
    freezeDate(NOW);
    stubApi((method, path) =>
      method === "POST" && path === "/api/reservations/res-1/checkout"
        ? json(409, { error: "RESERVATION_EXPIRED" })
        : json(404, {}),
    );
    saveReservation(view());
    renderAt("/reservations/res-1");

    fireEvent.click(payButton()!);

    expect(await screen.findAllByText(/Rezerwacja wygasła — miejsce wróciło do puli/)).toBeTruthy();
    expect(screen.getByRole("timer").textContent).toBe("00:00");
    expect(screen.queryByText(/czeka na Ciebie/)).toBeNull();
    expect(payButton()).toBeNull();
    expect(window.sessionStorage.getItem("pas.ticket.res-1")).toBeNull();
  });

  it("503 PAYMENTS_UNAVAILABLE: rezerwacja trwa, a komunikat zachęca do ponowienia", async () => {
    freezeDate(NOW);
    stubApi((method, path) =>
      method === "POST" && path === "/api/reservations/res-1/checkout"
        ? json(503, { error: "PAYMENTS_UNAVAILABLE", retryAfter: 5 })
        : json(404, {}),
    );
    saveReservation(view());
    renderAt("/reservations/res-1");

    fireEvent.click(payButton()!);

    expect(await screen.findByText(/Płatności chwilowo nie działają/)).toBeTruthy();
    expect((payButton() as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("karta C — powrót ze Stripe'a", () => {
  it("„płatność w toku…” sama zamienia się w bilet, gdy webhook oznaczy rezerwację", async () => {
    freezeDate(NOW);
    let paid = false;
    stubApi((method, path) =>
      path === "/api/reservations/res-1"
        ? json(200, {
            status: paid ? "paid" : "held",
            amount: 8900,
            expiresAt: new Date(NOW + TWO_MINUTES).toISOString(),
            ...(paid ? { code: "PAS-7K2M9Q" } : {}),
          })
        : json(404, {}),
    );
    saveReservation(view());
    renderAt("/reservations/res-1/payment/success");

    expect(await screen.findByText(/w toku/)).toBeTruthy();
    paid = true;

    const ticket = await screen.findByLabelText("Bilet PAS-7K2M9Q", undefined, { timeout: 4_000 });
    expect(ticketField(ticket, "Miejsce")).toBe("Wagon 5, miejsce 12");
    expect(window.sessionStorage.getItem("pas.ticket.res-1")).toContain("PAS-7K2M9Q");
  });

  it("wygasła przed potwierdzeniem: komunikat o zwrocie zamiast biletu", async () => {
    stubApi((_method, path) =>
      path === "/api/reservations/res-1"
        ? json(200, { status: "expired", amount: 8900, expiresAt: new Date(NOW).toISOString() })
        : json(404, {}),
    );
    saveReservation(view());
    renderAt("/reservations/res-1/payment/success");

    expect(await screen.findByText("Rezerwacja wygasła przed potwierdzeniem płatności")).toBeTruthy();
    expect(screen.getByText(/zwrócimy całą kwotę/)).toBeTruthy();
  });

  it("po przerwaniu płatności pozwala zapłacić ponownie tym samym kluczem", async () => {
    freezeDate(NOW);
    vi.spyOn(redirectTo, "assign").mockImplementation(() => undefined);
    const fetchMock = stubApi((method, path) => {
      if (path === "/api/reservations/res-1") {
        return json(200, { status: "held", amount: 8900, expiresAt: new Date(NOW + TWO_MINUTES).toISOString() });
      }
      if (method === "POST" && path === "/api/reservations/res-1/checkout") {
        return json(200, { url: "https://checkout.stripe.com/c/pay/cs_test_1" });
      }
      return json(404, {});
    });
    window.sessionStorage.setItem("pas.checkout-key.res-1", JSON.stringify("klucz-z-pierwszej-proby"));
    saveReservation(view());
    renderAt("/reservations/res-1/payment/cancel");

    expect(screen.getByText(/Płatność przerwana/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Zapłać ponownie 89 zł/ }));

    await waitFor(() => {
      const keys = fetchMock.mock.calls
        .filter(([input]) => String(input).endsWith("/checkout"))
        .map(([, init]) => (init?.headers as Record<string, string>)["idempotency-key"]);
      expect(keys).toEqual(["klucz-z-pierwszej-proby"]);
    });
  });

  it("opłacona rezerwacja na ekranie B (np. „Wstecz” ze Stripe'a) prowadzi do biletu", async () => {
    freezeDate(NOW);
    stubApi((_method, path) =>
      path === "/api/reservations/res-1"
        ? json(200, {
            status: "paid",
            amount: 8900,
            expiresAt: new Date(NOW + TWO_MINUTES).toISOString(),
            code: "PAS-7K2M9Q",
          })
        : json(404, {}),
    );
    saveReservation(view());
    renderAt("/reservations/res-1");

    expect(await screen.findByLabelText("Bilet PAS-7K2M9Q")).toBeTruthy();
  });
});
