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
    // Nowy wygląd: liczba połączeń i miejsc w statystykach nad listą („kursy”, „miejsc”).
    const stats = Object.fromEntries(
      [...container.querySelectorAll("#odjazdy dl > div")].map((stat) => [
        stat.querySelector("dt")?.textContent,
        stat.querySelector("dd")?.textContent,
      ]),
    );
    expect(stats).toMatchObject({ kursy: "2", miejsc: "80" });
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
    // Decyzja 2B: zamiast zablokowanego przycisku jedna akcja — powrót do planu wagonu.
    expect(screen.getByRole("link", { name: "Wróć do planu wagonu" })).toBeTruthy();
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

  it("pokazuje saldo, zmniejsza kwotę punktami i wysyła je w body checkoutu", async () => {
    freezeDate(NOW);
    const assign = vi.spyOn(redirectTo, "assign").mockImplementation(() => undefined);
    const fetchMock = stubApi((method, path) => {
      if (path === "/api/loyalty") return json(200, { email: "anna@example.com", points: 1000 });
      if (method === "POST" && path === "/api/reservations/res-1/checkout") {
        return json(200, { url: "https://checkout.stripe.com/c/pay/cs_test_points" });
      }
      return json(404, {});
    });
    saveReservation(view());
    renderAt("/reservations/res-1");

    const input = await screen.findByRole("spinbutton", { name: /użyj punktów/i });
    expect(screen.getByText(/1\s*000 pkt/)).toBeTruthy();

    fireEvent.change(input, { target: { value: "1000" } });
    expect(payButton()?.textContent).toContain("Zapłać 79 zł");

    fireEvent.click(payButton()!);
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test_points"),
    );

    const checkoutCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/checkout"));
    expect(JSON.parse(String(checkoutCall?.[1]?.body))).toEqual({ points: 1000 });
  });

  it("„Do zapłaty” w podsumowaniu kursu uwzględnia punkty: po wpisaniu i po „Użyj maksimum”", async () => {
    freezeDate(NOW);
    stubApi((_method, path) =>
      path === "/api/loyalty" ? json(200, { email: "anna@example.com", points: 1000 }) : json(404, {}),
    );
    saveReservation(view());
    renderAt("/reservations/res-1");

    /** Wiersze podsumowania kursu (dt → dd); nagłówek panelu „Do zapłaty” to h2, nie dt. */
    const summary = () =>
      Object.fromEntries(
        [...document.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent ?? ""]),
      );
    const status = () => screen.getByRole("status");

    const input = await screen.findByRole("spinbutton", { name: /użyj punktów/i });
    expect(summary()["Do zapłaty"]).toMatch(/^89\s*zł$/);
    expect(summary()["Punktami"]).toBeUndefined();
    // Bez zmian nic nie jest ogłaszane.
    expect(status().textContent).toBe("");

    fireEvent.change(input, { target: { value: "250" } });
    expect(summary()["Do zapłaty"]).toMatch(/^86,50\s*zł$/);
    expect(summary()["Cena biletu"]).toMatch(/^89\s*zł$/);
    expect(summary()["Punktami"]).toMatch(/^−\s*2,50\s*zł \(250 pkt\)$/);
    expect(payButton()?.textContent).toContain("Zapłać 86,50 zł");
    // Region aria-live czeka, aż klient przestanie pisać — nie ogłasza każdego znaku.
    expect(status().textContent).toBe("");
    await waitFor(() => expect(status().textContent).toMatch(/^Do zapłaty 86,50\s*zł: cena biletu 89\s*zł/), {
      timeout: 2000,
    });

    fireEvent.click(screen.getByRole("button", { name: "Użyj maksimum" }));
    expect(summary()["Do zapłaty"]).toMatch(/^79\s*zł$/);
    expect(summary()["Punktami"]).toMatch(/^−\s*10\s*zł \(1000 pkt\)$/);
    expect(payButton()?.textContent).toContain("Zapłać 79 zł");
    await waitFor(() => expect(status().textContent).toMatch(/^Do zapłaty 79\s*zł/), { timeout: 2000 });

    // Za dużo punktów: przycięte do limitu tak samo jak przycisk.
    fireEvent.change(input, { target: { value: "5000" } });
    expect(summary()["Do zapłaty"]).toMatch(/^79\s*zł$/);

    fireEvent.change(input, { target: { value: "0" } });
    expect(summary()["Do zapłaty"]).toMatch(/^89\s*zł$/);
    expect(summary()["Punktami"]).toBeUndefined();
    await waitFor(() => expect(status().textContent).toMatch(/^Do zapłaty 89\s*zł, bez punktów\.$/), {
      timeout: 2000,
    });
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

/** E-maile, o które UI zapytało `GET /api/loyalty` (każde to potencjalne wywołanie Voucherify). */
function loyaltyCalls(fetchMock: ReturnType<typeof stubApi>): string[] {
  return fetchMock.mock.calls
    .map(([input]) => new URL(String(input), "http://localhost"))
    .filter((url) => url.pathname === "/api/loyalty")
    .map((url) => url.searchParams.get("email") ?? "");
}

describe("karta A — saldo punktów oszczędza limit Voucherify (100 wywołań/h)", () => {
  it("literówki w trakcie pisania nie wysyłają zapytań; saldo po wyjściu z pola, raz na e-mail", async () => {
    const fetchMock = stubApi((_method, path) => {
      if (path === `/api/events/${event.id}`) return eventDetail();
      if (path === "/api/loyalty") return json(200, { email: "jan@wp.pl.com", points: 1000 });
      return json(404, {});
    });
    renderAt(reservePath);

    const input = await screen.findByLabelText("Adres e-mail");
    // „jan@wp.pl” wygląda na poprawny e-mail, ale klient pisze dalej.
    for (const value of ["jan@wp.pl", "jan@wp.pl.", "jan@wp.pl.c", "jan@wp.pl.co", "Jan@wp.pl.com "]) {
      fireEvent.change(input, { target: { value } });
    }
    // Dłużej niż dawny debounce (450 ms) — nadal żadnego zapytania.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(loyaltyCalls(fetchMock)).toEqual([]);

    fireEvent.blur(input);
    expect(await screen.findByText(/Masz 1\s*000 punktów/)).toBeTruthy();
    expect(loyaltyCalls(fetchMock)).toEqual(["jan@wp.pl.com"]);

    // Ponowne wejście i wyjście z pola z tym samym adresem nie pyta drugi raz.
    fireEvent.focus(input);
    fireEvent.blur(input);
    fireEvent.blur(input);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(loyaltyCalls(fetchMock)).toEqual(["jan@wp.pl.com"]);
  });

  it("niepoprawny e-mail po wyjściu z pola nie wysyła zapytania", async () => {
    const fetchMock = stubApi((_method, path) =>
      path === `/api/events/${event.id}` ? eventDetail() : json(200, { email: "x", points: 1000 }),
    );
    renderAt(reservePath);

    const input = await screen.findByLabelText("Adres e-mail");
    for (const value of ["jan", "jan@", "jan@wp", "jan@wp.p"]) {
      fireEvent.change(input, { target: { value } });
      fireEvent.blur(input);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(loyaltyCalls(fetchMock)).toEqual([]);
    expect(screen.queryByText(/Masz .* punktów/)).toBeNull();
  });

  it("503 LOYALTY_UNAVAILABLE: brak salda nie blokuje rezerwacji, a UI czeka Retry-After", async () => {
    freezeDate(NOW);
    const fetchMock = stubApi((method, path) => {
      if (path === `/api/events/${event.id}`) return eventDetail();
      if (path === "/api/loyalty") return json(503, { error: "LOYALTY_UNAVAILABLE", retryAfter: 120 });
      if (method === "POST" && path === "/api/reservations") {
        return json(201, { reservationId: "res-1", expiresAt: new Date(NOW + TWO_MINUTES).toISOString(), amount: 8900 });
      }
      return json(404, {});
    });
    renderAt(reservePath);

    fireEvent.change(await screen.findByLabelText("Imię i nazwisko"), { target: { value: "Anna Kowalska" } });
    const input = screen.getByLabelText("Adres e-mail");
    fireEvent.change(input, { target: { value: "anna@example.com" } });
    fireEvent.blur(input);
    await waitFor(() => expect(loyaltyCalls(fetchMock)).toEqual(["anna@example.com"]));

    // Inny adres w czasie Retry-After — bez zapytania (limit jest wspólny dla całej kasy).
    fireEvent.change(input, { target: { value: "anna.k@example.com" } });
    fireEvent.blur(input);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(loyaltyCalls(fetchMock)).toEqual(["anna@example.com"]);
    expect(screen.queryByText(/Masz .* punktów/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Rezerwuję na/ }));
    expect((await screen.findByRole("timer")).textContent).toBe("02:00");
    // Ekran płatności też nie pyta przed Retry-After, a płatność kartą jest dostępna.
    expect(payButton()?.textContent).toContain("Zapłać 89 zł");
    expect(screen.queryByRole("spinbutton", { name: /użyj punktów/i })).toBeNull();
    expect(loyaltyCalls(fetchMock)).toEqual(["anna@example.com"]);
  });

  it("ekran płatności używa salda pobranego przy rezerwacji — bez drugiego zapytania", async () => {
    freezeDate(NOW);
    const fetchMock = stubApi((method, path) => {
      if (path === `/api/events/${event.id}`) return eventDetail();
      if (path === "/api/loyalty") return json(200, { email: "anna@example.com", points: 1500 });
      if (method === "POST" && path === "/api/reservations") {
        return json(201, { reservationId: "res-1", expiresAt: new Date(NOW + TWO_MINUTES).toISOString(), amount: 8900 });
      }
      return json(404, {});
    });
    renderAt(reservePath);

    fireEvent.change(await screen.findByLabelText("Imię i nazwisko"), { target: { value: "Anna Kowalska" } });
    const input = screen.getByLabelText("Adres e-mail");
    fireEvent.change(input, { target: { value: "anna@example.com" } });
    fireEvent.blur(input);
    expect(await screen.findByText(/Masz 1\s*500 punktów/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Rezerwuję na/ }));
    expect(await screen.findByRole("spinbutton", { name: /użyj punktów/i })).toBeTruthy();
    expect(screen.getByText(/1\s*500 pkt/)).toBeTruthy();
    expect(loyaltyCalls(fetchMock)).toEqual(["anna@example.com"]);
  });

  it("429 przy saldzie: pole punktów znika, płatność kartą działa", async () => {
    freezeDate(NOW);
    const assign = vi.spyOn(redirectTo, "assign").mockImplementation(() => undefined);
    const fetchMock = stubApi((method, path) => {
      if (path === "/api/loyalty") return json(429, { error: "RATE_LIMITED", retryAfter: 10 });
      if (method === "POST" && path === "/api/reservations/res-1/checkout") {
        return json(200, { url: "https://checkout.stripe.com/c/pay/cs_test_card" });
      }
      return json(404, {});
    });
    saveReservation(view());
    renderAt("/reservations/res-1");

    await waitFor(() => expect(loyaltyCalls(fetchMock)).toHaveLength(1));
    expect(screen.queryByRole("spinbutton", { name: /użyj punktów/i })).toBeNull();

    fireEvent.click(payButton()!);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test_card"));
    const checkoutCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/checkout"));
    expect(JSON.parse(String(checkoutCall?.[1]?.body))).toEqual({ points: 0 });
  });

  it("po zapłacie punktami zapamiętane saldo jest zapominane", async () => {
    freezeDate(NOW);
    vi.spyOn(redirectTo, "assign").mockImplementation(() => undefined);
    window.sessionStorage.setItem("pas.loyalty.anna@example.com", JSON.stringify({ points: 1000, at: NOW }));
    const fetchMock = stubApi((method, path) =>
      method === "POST" && path === "/api/reservations/res-1/checkout"
        ? json(200, { url: "https://checkout.stripe.com/c/pay/cs_test_points" })
        : json(404, {}),
    );
    saveReservation(view());
    renderAt("/reservations/res-1");

    fireEvent.change(screen.getByRole("spinbutton", { name: /użyj punktów/i }), { target: { value: "1000" } });
    fireEvent.click(payButton()!);
    await waitFor(() => expect(window.sessionStorage.getItem("pas.loyalty.anna@example.com")).toBeNull());
    expect(loyaltyCalls(fetchMock)).toEqual([]);
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
    // Decyzja 1B: na bilecie osobno duży numer wagonu i miejsca.
    expect(ticketField(ticket, "Wagon")).toBe("5");
    expect(ticketField(ticket, "Miejsce")).toMatch(/^12(okno|korytarz)?$/);
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
