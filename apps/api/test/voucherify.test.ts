import { afterEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "../src/resilience";
import { LoyaltyProviderError, VoucherifyLoyaltyProvider } from "../src/loyalty";
import { ResendMailer, MailDeliveryError } from "../src/mail";

function provider(maxRetries = 0): VoucherifyLoyaltyProvider {
  return new VoucherifyLoyaltyProvider({
    appId: "app_test",
    appToken: "token_test",
    campaignId: "camp_test",
    apiUrl: "https://voucherify.example",
    timeoutMs: 1_000,
    maxRetries,
    breaker: new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 1_000, clock: () => 0 }),
    sleep: async () => undefined,
  });
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
