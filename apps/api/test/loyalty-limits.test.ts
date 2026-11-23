import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateReservationResponse, LoyaltyResponse, OpsStatus } from "@pas/shared";
import {
  checkoutCompletedEvent,
  createTestContext,
  newIdempotencyKey,
  reservationPayload,
  sendWebhook,
  type TestContext,
} from "./helpers";
import {
  accountRow,
  CountingLoyaltyProvider,
  seedAccount,
  stubVoucherify,
  voucherifyConfig,
} from "./loyalty-helpers";
import { LoyaltyProviderError, LoyaltyThrottledError } from "../src/loyalty";
import { MailDeliveryError } from "../src/mail";

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
  vi.unstubAllGlobals();
});

async function reserve(email = "anna@example.com", seatId = "5-1"): Promise<string> {
  const created = await ctx.app.inject({
    method: "POST",
    url: "/api/reservations",
    payload: reservationPayload({ email, seatId }),
  });
  expect(created.statusCode).toBe(201);
  return created.json<CreateReservationResponse>().reservationId;
}

function loyalty(email: string) {
  return ctx.app.inject({ method: "GET", url: `/api/loyalty?email=${encodeURIComponent(email)}` });
}

function checkout(reservationId: string, points?: number) {
  return ctx.app.inject({
    method: "POST",
    url: `/api/reservations/${reservationId}/checkout`,
    headers: { "idempotency-key": newIdempotencyKey() },
    ...(points === undefined ? {} : { payload: { points } }),
  });
}

/** Opłacenie ostatniej sesji Stripe'a (webhook completed). */
async function pay(reservationId: string): Promise<void> {
  const session = ctx.payments.sessions.at(-1)!;
  const response = await sendWebhook(
    ctx,
    checkoutCompletedEvent(ctx, { sessionId: session.result.id, reservationId, amount: session.input.amount }),
  );
  expect(response.statusCode).toBe(200);
}

describe("odczyt salda nie zakłada karty w Voucherify", () => {
  it("nowy e-mail: 1000 punktów bez żadnego wywołania i bez wiersza w bazie", async () => {
    const provider = new CountingLoyaltyProvider();
    ctx = await createTestContext({ loyaltyProvider: provider });

    // Literówki w trakcie pisania (jan@wp.pl → jan@wp.pl.com) nie zakładają kart.
    for (const email of ["jan@wp.pl", "jan@wp.pl.co", "jan@wp.pl.com", "jan@wp.pl.com"]) {
      const response = await loyalty(email);
      expect(response.statusCode).toBe(200);
      expect(response.json<LoyaltyResponse>()).toEqual({ email, points: 1000 });
    }

    expect(provider.calls).toEqual([]);
    expect(accountRow(ctx, "jan@wp.pl")).toBeUndefined();
    expect(accountRow(ctx, "jan@wp.pl.com")).toBeUndefined();
  });

  it("kartę i bonus zakłada dopiero pobranie punktów — bez dodatkowego odczytu salda", async () => {
    const provider = new CountingLoyaltyProvider();
    ctx = await createTestContext({ loyaltyProvider: provider });
    const reservationId = await reserve();

    expect((await checkout(reservationId, 1000)).statusCode).toBe(200);

    // createMember + bonus + pobranie = 3 wywołania; checkout nie czytał salda.
    expect(provider.calls.map((call) => call.op)).toEqual(["createMember", "adjustPoints", "adjustPoints"]);
    expect(provider.calls[1]).toMatchObject({ delta: 1000, reason: "welcome", priority: "checkout" });
    expect(provider.calls[2]).toMatchObject({ delta: -1000, reason: "checkout", priority: "checkout" });
    expect(accountRow(ctx, "anna@example.com")).toMatchObject({ welcome_pending: 0 });

    // Saldo po korekcie jest w cache — odczyt nie woła Voucherify.
    expect((await loyalty("anna@example.com")).json<LoyaltyResponse>().points).toBe(0);
    expect(provider.count("getBalance")).toBe(0);
  });

  it("zakup bez punktów: kartę zakłada naliczenie w workerze (priorytet krytyczny)", async () => {
    const provider = new CountingLoyaltyProvider();
    ctx = await createTestContext({ loyaltyProvider: provider });
    const reservationId = await reserve();

    expect((await checkout(reservationId)).statusCode).toBe(200);
    expect(provider.calls).toEqual([]);
    await pay(reservationId);
    expect(await ctx.services.worker.runOnce()).toBe(true);

    expect(provider.calls.map((call) => [call.op, call.priority])).toEqual([
      ["createMember", "critical"],
      ["adjustPoints", "critical"],
      ["adjustPoints", "critical"],
    ]);
    expect((await loyalty("anna@example.com")).json<LoyaltyResponse>().points).toBe(1000 + 890);
    expect(provider.count("getBalance")).toBe(0);
  });

  it("dwa równoległe pierwsze zakupy: jedna karta i jeden bonus", async () => {
    const provider = new CountingLoyaltyProvider();
    ctx = await createTestContext({ loyaltyProvider: provider });
    const first = await reserve("anna@example.com", "5-1");
    const second = await reserve("anna@example.com", "5-2");

    const responses = await Promise.all([checkout(first, 400), checkout(second, 400)]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);

    expect(provider.count("createMember")).toBe(1);
    expect(provider.calls.filter((call) => call.op === "adjustPoints" && call.reason === "welcome")).toHaveLength(1);
    expect(await provider.getBalance("anna@example.com")).toBe(200);
  });

  it("karta istnieje w Voucherify, a baza zgubiła mapowanie: bez drugiego bonusu", async () => {
    const provider = new CountingLoyaltyProvider();
    // Stara karta z historią: bonus był przyznany, klient wydał część punktów.
    await provider.createMember("anna@example.com");
    await provider.adjustPoints("anna@example.com", 1000, "welcome");
    await provider.adjustPoints("anna@example.com", -700, "checkout");
    provider.calls = [];
    ctx = await createTestContext({ loyaltyProvider: provider });
    const reservationId = await reserve();

    expect((await checkout(reservationId, 200)).statusCode).toBe(200);
    expect(provider.calls.filter((call) => call.op === "adjustPoints").map((call) => call.reason)).toEqual([
      "checkout",
    ]);
    expect((await loyalty("anna@example.com")).json<LoyaltyResponse>().points).toBe(100);
  });

  it("karta bez historii (timeout przy zakładaniu) dostaje bonus przy następnej próbie", async () => {
    const provider = new CountingLoyaltyProvider();
    // Poprzednia próba założyła kartę, ale odpowiedź nie dotarła — brak mapowania i punktów.
    await provider.createMember("anna@example.com");
    provider.calls = [];
    ctx = await createTestContext({ loyaltyProvider: provider });
    const reservationId = await reserve();

    expect((await checkout(reservationId, 1000)).statusCode).toBe(200);
    expect(provider.calls.filter((call) => call.op === "adjustPoints").map((call) => call.delta)).toEqual([
      1000, -1000,
    ]);
  });

  it("bonus odrzucony na pewno (limit) zostaje należny: odczyt dalej pokazuje 1000, następny zapis go przyznaje", async () => {
    const provider = new CountingLoyaltyProvider();
    ctx = await createTestContext({ loyaltyProvider: provider });
    const reservationId = await reserve();
    provider.failNext.adjustPoints = new LoyaltyThrottledError("budżet", 120, "budget");

    const refused = await checkout(reservationId, 1000);
    expect(refused.statusCode).toBe(503);
    expect(refused.headers["retry-after"]).toBe("120");
    expect(refused.json()).toEqual({ error: "LOYALTY_UNAVAILABLE", message: expect.any(String), retryAfter: 120 });
    expect(accountRow(ctx, "anna@example.com")).toMatchObject({ welcome_pending: 1 });
    expect(ctx.payments.sessions).toHaveLength(0);

    provider.calls = [];
    expect((await loyalty("anna@example.com")).json<LoyaltyResponse>().points).toBe(1000);
    expect(provider.calls).toEqual([]);

    expect((await checkout(reservationId, 1000)).statusCode).toBe(200);
    expect(provider.calls.filter((call) => call.op === "adjustPoints").map((call) => call.delta)).toEqual([
      1000, -1000,
    ]);
    expect(accountRow(ctx, "anna@example.com")).toMatchObject({ welcome_pending: 0 });
  });

  it("bonus z niepewnym wynikiem (timeout po zapisie): następna próba sprawdza saldo i nie dubluje", async () => {
    const provider = new CountingLoyaltyProvider();
    ctx = await createTestContext({ loyaltyProvider: provider });
    const reservationId = await reserve();
    provider.failAfterApply = new LoyaltyProviderError("Voucherify: timeout po 5000 ms", true);

    expect((await checkout(reservationId, 1000)).statusCode).toBe(503);
    expect(accountRow(ctx, "anna@example.com")).toMatchObject({ welcome_pending: 2 });

    provider.calls = [];
    expect((await checkout(reservationId, 1000)).statusCode).toBe(200);
    expect(provider.calls.map((call) => call.op)).toEqual(["getBalance", "adjustPoints"]);
    expect(provider.calls[1]).toMatchObject({ delta: -1000 });
    expect(await provider.getBalance("anna@example.com")).toBe(0);
  });
});

describe("cache salda — optymalizacja odczytu, źródłem prawdy jest Voucherify", () => {
  async function withExistingCard(points: number): Promise<CountingLoyaltyProvider> {
    const provider = new CountingLoyaltyProvider();
    await provider.createMember("anna@example.com");
    await provider.adjustPoints("anna@example.com", points, "welcome");
    provider.calls = [];
    ctx = await createTestContext({
      loyaltyProvider: provider,
      overrides: { loyalty: { balanceCacheTtlMs: 30_000, balanceStaleTtlMs: 600_000 } },
    });
    seedAccount(ctx, "anna@example.com", "anna@example.com");
    return provider;
  }

  it("trafienie w TTL nie woła Voucherify; po TTL widać zmianę zrobioną poza nami", async () => {
    const provider = await withExistingCard(1500);

    expect((await loyalty("anna@example.com")).json<LoyaltyResponse>().points).toBe(1500);
    expect((await loyalty("ANNA@example.com")).json<LoyaltyResponse>().points).toBe(1500);
    expect(provider.count("getBalance")).toBe(1);

    // Marketing dopisał punkty w panelu Voucherify — cache tego nie wie aż do końca TTL.
    await provider.adjustPoints("anna@example.com", 500, "marketing");
    ctx.advance(29_000);
    expect((await loyalty("anna@example.com")).json<LoyaltyResponse>().points).toBe(1500);
    ctx.advance(1_000);
    expect((await loyalty("anna@example.com")).json<LoyaltyResponse>().points).toBe(2000);
    expect(provider.count("getBalance")).toBe(2);

    const status = (await ctx.app.inject({ method: "GET", url: "/api/ops/status" })).json<OpsStatus>();
    expect(status.loyalty?.cache).toMatchObject({ ttlSeconds: 30, hits: 2, misses: 2 });
  });

  it("nasza korekta od razu nadpisuje cache, a nieudana go unieważnia", async () => {
    const provider = await withExistingCard(1500);
    expect((await loyalty("anna@example.com")).json<LoyaltyResponse>().points).toBe(1500);

    await ctx.services.loyalty.awardPoints("anna@example.com", 250);
    expect((await loyalty("anna@example.com")).json<LoyaltyResponse>().points).toBe(1750);
    expect(provider.count("getBalance")).toBe(1);

    provider.failNext.adjustPoints = new LoyaltyProviderError("Voucherify 503", true, 503);
    await expect(ctx.services.loyalty.awardPoints("anna@example.com", 100)).rejects.toMatchObject({
      code: "LOYALTY_UNAVAILABLE",
    });
    expect((await loyalty("anna@example.com")).json<LoyaltyResponse>().points).toBe(1750);
    expect(provider.count("getBalance")).toBe(2);
  });

  it("checkout korzysta ze świeżego cache; za mało punktów i tak zatrzymuje atomowe pobranie", async () => {
    const provider = await withExistingCard(1500);
    expect((await loyalty("anna@example.com")).json<LoyaltyResponse>().points).toBe(1500);
    // Ktoś wydał punkty poza naszym procesem — cache wciąż mówi 1500.
    await provider.adjustPoints("anna@example.com", -1400, "inny kanał");
    provider.calls = [];

    const reservationId = await reserve();
    const response = await checkout(reservationId, 1000);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "INSUFFICIENT_POINTS" });
    // Wstępne sprawdzenie z cache, potem atomowa korekta w Voucherify odmówiła.
    expect(provider.calls.map((call) => call.op)).toEqual(["adjustPoints"]);
    expect(ctx.payments.sessions).toHaveLength(0);
    expect(await provider.getBalance("anna@example.com")).toBe(100);
  });

  it("Voucherify padł: wyświetlanie dostaje niedawne saldo, checkout — 503, nie stare dane", async () => {
    const provider = await withExistingCard(1500);
    expect((await loyalty("anna@example.com")).json<LoyaltyResponse>().points).toBe(1500);
    ctx.advance(60_000);

    provider.failNext.getBalance = new LoyaltyProviderError("Voucherify 503", true, 503);
    const stale = await loyalty("anna@example.com");
    expect(stale.statusCode).toBe(200);
    expect(stale.json<LoyaltyResponse>().points).toBe(1500);

    const reservationId = await reserve();
    provider.failNext.getBalance = new LoyaltyProviderError("Voucherify 503", true, 503);
    const refused = await checkout(reservationId, 1000);
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({ error: "LOYALTY_UNAVAILABLE" });

    // Starsze niż LOYALTY_BALANCE_STALE_SECONDS — tylko 503.
    ctx.advance(600_000);
    provider.failNext.getBalance = new LoyaltyProviderError("Voucherify 503", true, 503);
    expect((await loyalty("anna@example.com")).statusCode).toBe(503);
  });
});

describe("budżet wywołań Voucherify w aplikacji (Sandbox: 100/h)", () => {
  it("odczyty kończą się pierwsze (503 z Retry-After), zakup i zwroty mają rezerwę", async () => {
    const voucherify = stubVoucherify();
    ctx = await createTestContext({
      overrides: {
        loyalty: voucherifyConfig({ hourlyBudget: 4, reserveCritical: 1, reserveCheckout: 1 }),
      },
    });
    for (const name of ["anna", "bartek", "celina"]) {
      seedAccount(ctx, `${name}@example.com`, `CARD-${name}@example.com`);
      voucherify.balances.set(`CARD-${name}@example.com`, 2000);
    }

    expect((await loyalty("anna@example.com")).statusCode).toBe(200);
    expect((await loyalty("bartek@example.com")).statusCode).toBe(200);
    const denied = await loyalty("celina@example.com");
    expect(denied.statusCode).toBe(503);
    expect(denied.headers["retry-after"]).toBe("3600");
    expect(denied.json()).toEqual({ error: "LOYALTY_UNAVAILABLE", message: expect.any(String), retryAfter: 3600 });
    expect(voucherify.fetchMock).toHaveBeenCalledTimes(2);

    // Saldo z cache nadal działa, a nowy e-mail nie potrzebuje Voucherify wcale.
    expect((await loyalty("anna@example.com")).json<LoyaltyResponse>().points).toBe(2000);
    expect((await loyalty("nowy@example.com")).json<LoyaltyResponse>().points).toBe(1000);

    // Checkout ma swoją rezerwę: pobranie punktów przechodzi mimo wyczerpanych odczytów.
    const reservationId = await reserve("anna@example.com");
    expect((await checkout(reservationId, 1000)).statusCode).toBe(200);
    expect(voucherify.balances.get("CARD-anna@example.com")).toBe(1000);

    // Zwrot punktów (operacja krytyczna) ma ostatnią rezerwę.
    await expect(ctx.services.loyalty.awardPoints("anna@example.com", 1000)).resolves.toBe(2000);
    await expect(ctx.services.loyalty.awardPoints("anna@example.com", 1)).rejects.toMatchObject({
      code: "LOYALTY_UNAVAILABLE",
    });
    expect(voucherify.fetchMock).toHaveBeenCalledTimes(4);

    const status = (await ctx.app.inject({ method: "GET", url: "/api/ops/status" })).json<OpsStatus>();
    expect(status.loyalty).toMatchObject({
      provider: "voucherify",
      budget: { limit: 4, used: 4, readCap: 2, checkoutCap: 3, windowSeconds: 3600 },
    });
    expect(status.loyalty?.budget.denied).toBeGreaterThanOrEqual(2);

    // Po godzinie okno się zwalnia.
    ctx.advance(3_600_000);
    expect((await loyalty("celina@example.com")).statusCode).toBe(200);
  });

  it("429 od Voucherify: Retry-After trafia do klienta, bez ponowień i bez kolejnych wywołań", async () => {
    const voucherify = stubVoucherify();
    voucherify.state.rateLimitedFor = "120";
    ctx = await createTestContext({ overrides: { loyalty: voucherifyConfig({ maxRetries: 2 }) } });
    seedAccount(ctx, "anna@example.com", "CARD-anna@example.com");
    seedAccount(ctx, "bartek@example.com", "CARD-bartek@example.com");

    const first = await loyalty("anna@example.com");
    expect(first.statusCode).toBe(503);
    expect(first.headers["retry-after"]).toBe("120");
    expect(voucherify.fetchMock).toHaveBeenCalledTimes(1);

    ctx.advance(20_000);
    const second = await loyalty("bartek@example.com");
    expect(second.statusCode).toBe(503);
    expect(second.headers["retry-after"]).toBe("100");
    expect(voucherify.fetchMock).toHaveBeenCalledTimes(1);

    const status = (await ctx.app.inject({ method: "GET", url: "/api/ops/status" })).json<OpsStatus>();
    expect(status.loyalty?.budget.blockedUntil).not.toBeNull();

    ctx.advance(100_000);
    voucherify.state.rateLimitedFor = null;
    expect((await loyalty("bartek@example.com")).statusCode).toBe(200);
  });

  it("awaria Voucherify nie wycieka do klienta — tylko kod i Retry-After", async () => {
    const voucherify = stubVoucherify();
    voucherify.state.down = true;
    ctx = await createTestContext({ overrides: { loyalty: voucherifyConfig() } });
    seedAccount(ctx, "anna@example.com", "CARD-anna@example.com");

    const response = await loyalty("anna@example.com");
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "LOYALTY_UNAVAILABLE", message: expect.any(String), retryAfter: 5 });
    expect(response.body).not.toContain("secret");
    expect(response.body).not.toContain("CARD-");
  });

  it("wyczerpany budżet nie spycha naliczenia do DLQ: job czeka na okno, próba się nie liczy", async () => {
    const voucherify = stubVoucherify();
    ctx = await createTestContext({
      overrides: {
        loyalty: voucherifyConfig({ hourlyBudget: 3, reserveCritical: 0, reserveCheckout: 0 }),
        worker: { maxAttempts: 2 },
      },
    });
    const reservationId = await reserve();
    expect((await checkout(reservationId)).statusCode).toBe(200);
    await pay(reservationId);
    for (let index = 0; index < 3; index += 1) ctx.services.loyaltyBudget.record();

    expect(await ctx.services.worker.runOnce()).toBe(true);
    const job = ctx.services.jobs.list(5)[0]!;
    expect(job.state).toBe("retry");
    expect(job.totalTried).toBe(0);
    expect(Date.parse(job.visibleAt) - ctx.now()).toBe(3_600_000);
    expect(voucherify.fetchMock).not.toHaveBeenCalled();

    ctx.advance(3_600_000);
    expect(await ctx.services.worker.runOnce()).toBe(true);
    expect(ctx.services.jobs.stats()).toMatchObject({ done: 1, dlq: 0 });
    expect(voucherify.balances.get("CARD-anna@example.com")).toBe(1000 + 890);
    // Mail poszedł dwa razy z tym samym kluczem — dostawca deduplikuje po Idempotency-Key.
    expect(new Set(ctx.mailer.calls.map((call) => call.key)).size).toBe(1);
  });
});

describe("GET /api/loyalty — walidacja i limit per IP", () => {
  it("brak, pusty, powtórzony, za długi albo zły e-mail → 400 VALIDATION_ERROR", async () => {
    const provider = new CountingLoyaltyProvider();
    ctx = await createTestContext({ loyaltyProvider: provider });

    const urls = [
      "/api/loyalty",
      "/api/loyalty?email=",
      "/api/loyalty?email=%20%20",
      "/api/loyalty?email=a%40example.com&email=b%40example.com",
      `/api/loyalty?email=${"a".repeat(150)}%40example.com`,
      "/api/loyalty?email=anna%40example",
      "/api/loyalty?email=anna%20kowalska%40example.com",
    ];
    for (const url of urls) {
      const response = await ctx.app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(400);
      expect(response.json()).toEqual({ error: "VALIDATION_ERROR", message: expect.any(String) });
    }
    expect(provider.calls).toEqual([]);
  });

  it("limit per IP: 429 RATE_LIMITED z Retry-After; zły e-mail oddaje żeton", async () => {
    ctx = await createTestContext({
      overrides: {
        rateLimit: {
          enabled: true,
          global: { capacity: 1_000, refillPerSecond: 0 },
          loyalty: { capacity: 2, refillPerSecond: 0.1 },
        },
      },
    });

    for (let index = 0; index < 3; index += 1) {
      expect((await loyalty("zly-adres")).statusCode).toBe(400);
    }
    expect((await loyalty("anna@example.com")).statusCode).toBe(200);
    expect((await loyalty("anna@example.com")).statusCode).toBe(200);

    const limited = await loyalty("anna@example.com");
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "RATE_LIMITED", message: expect.any(String), retryAfter: 10 });
    expect(limited.headers["retry-after"]).toBe("10");
    expect(limited.headers["ratelimit-limit"]).toBe("2");

    ctx.advance(10_000);
    expect((await loyalty("anna@example.com")).statusCode).toBe(200);
  });
});

describe("Resend Sandbox a punkty", () => {
  it("trwały błąd Resend (403: Sandbox wysyła tylko na adres właściciela) nie blokuje naliczenia", async () => {
    ctx = await createTestContext();
    ctx.mailer.failWith = new MailDeliveryError(
      "Resend 403: You can only send testing emails to your own email address.",
      false,
      403,
    );
    const reservationId = await reserve("obcy@example.com");
    expect((await checkout(reservationId)).statusCode).toBe(200);
    await pay(reservationId);

    expect(await ctx.services.worker.runOnce()).toBe(true);
    expect(ctx.services.jobs.stats()).toMatchObject({ dlq: 1, retry: 0 });
    expect((await loyalty("obcy@example.com")).json<LoyaltyResponse>().points).toBe(1000 + 890);

    // Przywrócenie joba z DLQ nie nalicza punktów drugi raz.
    const job = ctx.services.jobs.list(5)[0]!;
    ctx.mailer.failWith = null;
    expect(ctx.services.jobs.retry(job.id)).toBe(true);
    expect(await ctx.services.worker.runOnce()).toBe(true);
    expect((await loyalty("obcy@example.com")).json<LoyaltyResponse>().points).toBe(1000 + 890);
  });
});
