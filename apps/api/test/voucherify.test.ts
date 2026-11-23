import { afterEach, describe, expect, it, vi } from "vitest";
import { CallBudget, CircuitBreaker } from "../src/resilience";
import {
  LoyaltyProviderError,
  LoyaltyThrottledError,
  parseRetryAfterMs,
  VoucherifyLoyaltyProvider,
} from "../src/loyalty";
import { ResendMailer, MailDeliveryError } from "../src/mail";

function provider(
  maxRetries = 0,
  extra: { budget?: CallBudget; breaker?: CircuitBreaker; clock?: () => number } = {},
): VoucherifyLoyaltyProvider {
  return new VoucherifyLoyaltyProvider({
    appId: "app_test",
    appToken: "token_test",
    campaignId: "camp_test",
    apiUrl: "https://voucherify.example",
    timeoutMs: 1_000,
    maxRetries,
    breaker:
      extra.breaker ?? new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 1_000, clock: () => 0 }),
    sleep: async () => undefined,
    ...(extra.budget ? { budget: extra.budget } : {}),
    ...(extra.clock ? { clock: extra.clock } : {}),
  });
}

function hourlyBudget(clock: () => number, limit = 90): CallBudget {
  return new CallBudget({ limit, windowMs: 3_600_000, reserveCritical: 20, reserveCheckout: 20, clock });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Voucherify — legacy loyalty API", () => {
  it("zakłada kartę z customer.source_id = e-mail i zwraca kod karty", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ code: "CARD123" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(provider().createMember("anna@example.com")).resolves.toEqual({
      memberId: "CARD123",
      hasHistory: false,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://voucherify.example/v1/loyalties/camp_test/members");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-App-Id"]).toBe("app_test");
    expect((init.headers as Record<string, string>)["X-App-Token"]).toBe("token_test");
    expect(JSON.parse(String(init.body))).toEqual({
      customer: { source_id: "anna@example.com", email: "anna@example.com" },
    });
  });

  it("czyta saldo z loyalty_card.balance, a nie z points (suma historii)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ code: "CARD123", loyalty_card: { points: 5000, balance: 1200 } })),
    );

    await expect(provider().getBalance("CARD123")).resolves.toBe(1200);
  });

  it("koryguje saldo przez POST /balance z ujemną liczbą punktów", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ points: -100, total: 1000, balance: 900 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(provider().adjustPoints("CARD123", -100, "checkout")).resolves.toBe(900);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://voucherify.example/v1/loyalties/members/CARD123/balance");
    expect(JSON.parse(String(init.body))).toEqual({ points: -100, reason: "checkout" });
  });

  it("400 przy korekcie oznacza brak punktów, a 503 jest ponawialne", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ code: 400, message: "insufficient points" }, 400)),
    );
    await expect(provider().adjustPoints("CARD123", -100, "checkout")).rejects.toMatchObject({
      name: "LoyaltyProviderError",
      insufficient: true,
      retryable: false,
    });

    const failing = vi.fn(async () => jsonResponse({ message: "padło" }, 503));
    vi.stubGlobal("fetch", failing);
    await expect(provider(2).getBalance("CARD123")).rejects.toBeInstanceOf(LoyaltyProviderError);
    // 1 próba + 2 ponowienia.
    expect(failing).toHaveBeenCalledTimes(3);
  });
});

describe("Resend", () => {
  it("wysyła tekst z kluczem API i Idempotency-Key joba", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "mail_123" }, 200));
    vi.stubGlobal("fetch", fetchMock);

    const mailer = new ResendMailer({
      apiKey: "re_test",
      from: "PAS Kasa <onboarding@resend.dev>",
      apiUrl: "https://api.resend.example",
      timeoutMs: 1_000,
    });
    await expect(
      mailer.send(
        { to: "anna@example.com", subject: "Bilet", text: "Treść", reservationId: "r1" },
        "job-1",
      ),
    ).resolves.toEqual({ id: "mail_123", duplicate: false });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.example/emails");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer re_test");
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBe("job-1");
    expect(JSON.parse(String(init.body))).toMatchObject({
      from: "PAS Kasa <onboarding@resend.dev>",
      to: ["anna@example.com"],
      subject: "Bilet",
      text: "Treść",
    });
  });

  it("4xx jest trwałe (bez retry), 5xx ponawialne", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "zły klucz" }, 401)));
    const mailer = new ResendMailer({
      apiKey: "re_test",
      from: "PAS <x@example.com>",
      apiUrl: "https://api.resend.example",
      timeoutMs: 1_000,
    });
    await expect(
      mailer.send({ to: "a@example.com", subject: "x", text: "y", reservationId: "r" }, "k"),
    ).rejects.toMatchObject({ name: "MailDeliveryError", retryable: false });

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "padło" }, 503)));
    await expect(
      mailer.send({ to: "a@example.com", subject: "x", text: "y", reservationId: "r" }, "k"),
    ).rejects.toBeInstanceOf(MailDeliveryError);
  });
});

describe("Voucherify — limit 100 wywołań/h", () => {
  it("429 nie jest ponawiane: respektuje Retry-After, blokuje budżet i nie grzeje bezpiecznika", async () => {
    let now = 0;
    const clock = () => now;
    const budget = hourlyBudget(clock);
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 30_000, clock });
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ code: 429, message: "Too many requests" }), {
        status: 429,
        headers: { "retry-after": "120" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const voucherify = provider(2, { budget, breaker, clock });

    await expect(voucherify.getBalance("CARD123")).rejects.toMatchObject({
      name: "LoyaltyThrottledError",
      source: "voucherify",
      retryAfterSeconds: 120,
    });
    // Mimo maxRetries = 2: jedno wywołanie, bez natychmiastowego ponowienia.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 429 to nie awaria — bezpiecznik z progiem 1 wciąż zamknięty.
    expect(breaker.snapshot()).toMatchObject({ state: "closed", failures: 0 });

    // Do końca Retry-After nie wołamy Voucherify wcale, nawet dla operacji krytycznych.
    now = 60_000;
    await expect(voucherify.adjustPoints("CARD123", 100, "purchase", "critical")).rejects.toMatchObject({
      name: "LoyaltyThrottledError",
      retryAfterSeconds: 60,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now = 120_000;
    fetchMock.mockImplementation(async () => jsonResponse({ code: "CARD123", loyalty_card: { balance: 500 } }));
    await expect(voucherify.getBalance("CARD123")).resolves.toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("Retry-After jako data HTTP albo bez nagłówka (minuta), z górną granicą godziny", () => {
    const now = Date.parse("2026-11-01T09:00:00.000Z");
    expect(parseRetryAfterMs("Sun, 01 Nov 2026 09:05:00 GMT", now)).toBe(300_000);
    expect(parseRetryAfterMs(null, now)).toBe(60_000);
    expect(parseRetryAfterMs("bzdura", now)).toBe(60_000);
    expect(parseRetryAfterMs("0", now)).toBe(1_000);
    expect(parseRetryAfterMs("86400", now)).toBe(3_600_000);
  });

  it("wyczerpany budżet: odmowa bez wywołania Voucherify, z czasem do zwolnienia miejsca", async () => {
    const now = 0;
    const budget = new CallBudget({ limit: 3, windowMs: 3_600_000, reserveCritical: 1, reserveCheckout: 1, clock: () => now });
    const fetchMock = vi.fn(async () => jsonResponse({ code: "CARD123", loyalty_card: { balance: 1 } }));
    vi.stubGlobal("fetch", fetchMock);
    const voucherify = provider(0, { budget, clock: () => now });

    await expect(voucherify.getBalance("CARD123", "read")).resolves.toBe(1);
    const denied = await voucherify.getBalance("CARD123", "read").catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(LoyaltyThrottledError);
    expect(denied).toMatchObject({ source: "budget", retryAfterSeconds: 3_600 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Checkout i operacje krytyczne mają jeszcze swoją rezerwę.
    await expect(voucherify.getBalance("CARD123", "checkout")).resolves.toBe(1);
    await expect(voucherify.getBalance("CARD123", "critical")).resolves.toBe(1);
    await expect(voucherify.getBalance("CARD123", "critical")).rejects.toBeInstanceOf(LoyaltyThrottledError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(budget.snapshot()).toMatchObject({ used: 3, denied: 2 });
  });

  it("ponowienia też kosztują budżet, a otwarty bezpiecznik nie kosztuje nic", async () => {
    const now = 0;
    const budget = hourlyBudget(() => now);
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 30_000, clock: () => now });
    const failing = vi.fn(async () => jsonResponse({ message: "padło" }, 503));
    vi.stubGlobal("fetch", failing);
    const voucherify = provider(2, { budget, breaker, clock: () => now });

    await expect(voucherify.getBalance("CARD123")).rejects.toBeInstanceOf(LoyaltyProviderError);
    expect(failing).toHaveBeenCalledTimes(3);
    expect(budget.snapshot().used).toBe(3);
    expect(breaker.state).toBe("open");

    await expect(voucherify.getBalance("CARD123")).rejects.toMatchObject({ name: "CircuitOpenError" });
    expect(failing).toHaveBeenCalledTimes(3);
    expect(budget.snapshot().used).toBe(3);
  });

  it("korekta salda nie jest ponawiana po 5xx/timeoucie — mogłaby pobrać punkty dwa razy", async () => {
    const failing = vi.fn(async () => jsonResponse({ message: "padło" }, 503));
    vi.stubGlobal("fetch", failing);

    await expect(provider(2).adjustPoints("CARD123", -100, "checkout")).rejects.toMatchObject({
      name: "LoyaltyProviderError",
      retryable: true,
    });
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("karta już istnieje (brak mapowania): findMember zwraca ją z informacją o historii punktów", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("?customer=")) {
        return jsonResponse({ data: [{ code: "CARD9", loyalty_card: { points: 1000, balance: 200 } }] });
      }
      return jsonResponse({ code: 400, key: "duplicate_found" }, 400);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(provider().createMember("anna@example.com")).resolves.toEqual({
      memberId: "CARD9",
      hasHistory: true,
    });
    const [url] = fetchMock.mock.calls[1] as unknown as [string];
    expect(url).toBe(
      "https://voucherify.example/v1/loyalties/camp_test/members?customer=anna%40example.com&limit=1",
    );
  });
});

describe("Resend — Sandbox", () => {
  const mailer = () =>
    new ResendMailer({
      apiKey: "re_test",
      from: "PAS Kasa <onboarding@resend.dev>",
      apiUrl: "https://api.resend.example",
      timeoutMs: 1_000,
    });

  it("403 „tylko na własny adres” (Sandbox bez domeny) jest błędem trwałym", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            statusCode: 403,
            name: "validation_error",
            message: "You can only send testing emails to your own email address.",
          },
          403,
        ),
      ),
    );
    await expect(
      mailer().send({ to: "obcy@example.com", subject: "x", text: "y", reservationId: "r" }, "k"),
    ).rejects.toMatchObject({ name: "MailDeliveryError", retryable: false, status: 403 });
  });

  it("bounced@resend.dev Resend przyjmuje (200) — odbicie przychodzi później, asynchronicznie", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ id: "mail_bounce" }, 200)));
    await expect(
      mailer().send({ to: "bounced@resend.dev", subject: "x", text: "y", reservationId: "r" }, "k"),
    ).resolves.toEqual({ id: "mail_bounce", duplicate: false });
  });
});
