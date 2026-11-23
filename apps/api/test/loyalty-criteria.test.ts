import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateReservationResponse, LoyaltyResponse, ReservationStatusResponse } from "@pas/shared";
import { type LoyaltyPriority } from "../src/loyalty";
import {
  checkoutCompletedEvent,
  createTestContext,
  newIdempotencyKey,
  reservationPayload,
  sendWebhook,
  stripeDown,
  type TestContext,
} from "./helpers";
import { accountRow, CountingLoyaltyProvider, seedAccount, stubVoucherify, voucherifyConfig } from "./loyalty-helpers";

let ctx: TestContext;

afterEach(async () => {
  await ctx?.close();
  vi.unstubAllGlobals();
});

/** Wagon 5 ma miejsca 5-1 … 5-20. */
const SEATS = Array.from({ length: 20 }, (_, index) => `5-${index + 1}`);

async function reserve(email: string, seatId: string, ip = "10.0.0.1"): Promise<string> {
  const created = await ctx.app.inject({
    method: "POST",
    url: "/api/reservations",
    payload: reservationPayload({ email, seatId }),
    remoteAddress: ip,
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json<CreateReservationResponse>().reservationId;
}

function checkout(reservationId: string, points?: number, ip = "10.0.0.1", key = newIdempotencyKey()) {
  return ctx.app.inject({
    method: "POST",
    url: `/api/reservations/${reservationId}/checkout`,
    headers: { "idempotency-key": key },
    remoteAddress: ip,
    ...(points === undefined ? {} : { payload: { points } }),
  });
}

function loyalty(email: string, ip = "10.0.0.1") {
  return ctx.app.inject({
    method: "GET",
    url: `/api/loyalty?email=${encodeURIComponent(email)}`,
    remoteAddress: ip,
  });
}

async function balance(email: string): Promise<number> {
  const response = await loyalty(email);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<LoyaltyResponse>().points;
}

async function status(reservationId: string): Promise<ReservationStatusResponse> {
  return (await ctx.app.inject({ method: "GET", url: `/api/reservations/${reservationId}` })).json();
}

async function pay(reservationId: string): Promise<void> {
  const session = ctx.payments.sessions.at(-1)!;
  const response = await sendWebhook(
    ctx,
    checkoutCompletedEvent(ctx, { sessionId: session.result.id, reservationId, amount: session.input.amount }),
  );
  expect(response.statusCode).toBe(200);
}

describe("III.B3 — dwa równoległe checkouty na jednym saldzie", () => {
  it("dostawca DOPUSZCZA saldo ujemne: 5 prób → zawsze jeden 200 i jeden 409, saldo nigdy < 0", async () => {
    const provider = new CountingLoyaltyProvider({ allowNegative: true });
    ctx = await createTestContext({ loyaltyProvider: provider });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const email = `wyscig${attempt}@example.com`;
      const first = await reserve(email, SEATS[attempt * 2]!);
      const second = await reserve(email, SEATS[attempt * 2 + 1]!);
      expect(await balance(email)).toBe(1000);

      const responses = await Promise.all([checkout(first, 1000), checkout(second, 1000)]);
      const codes = responses.map((response) => response.statusCode).sort();
      expect(codes).toEqual([200, 409]);
      const loser = responses.find((response) => response.statusCode === 409)!;
      expect(loser.json()).toEqual({ error: "INSUFFICIENT_POINTS", message: expect.any(String) });

      expect(await provider.getBalance(email)).toBe(0);
      // Dokładnie jedno pobranie −1000 w historii karty.
      expect(
        provider.calls.filter((call) => call.op === "adjustPoints" && call.memberId === email && call.delta === -1000),
      ).toHaveLength(1);

      // Przegrana rezerwacja: pointsUsed 0 i da się ją kupić bez punktów (sesja 8900).
      const loserId = responses[0]!.statusCode === 409 ? first : second;
      expect(await status(loserId)).toMatchObject({ status: "held", pointsUsed: 0 });
      expect((await checkout(loserId)).statusCode).toBe(200);
      expect(ctx.payments.sessions.at(-1)!.input.amount).toBe(8900);
    }
    expect(ctx.payments.sessions.filter((session) => session.input.amount === 7900)).toHaveLength(5);
  });

  it("prawdziwy klient Voucherify (HTTP) przy saldzie ujemnym w Voucherify: jeden 200, jeden 409, koszt 3 + 1 wywołania", async () => {
    const voucherify = stubVoucherify();
    voucherify.state.allowNegative = true;
    ctx = await createTestContext({ overrides: { loyalty: voucherifyConfig() } });
    const first = await reserve("ola@example.com", "5-1");
    const second = await reserve("ola@example.com", "5-2");

    const responses = await Promise.all([checkout(first, 1000), checkout(second, 1000)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(voucherify.balances.get("CARD-ola@example.com")).toBe(0);
    // Zwycięzca: karta + bonus + pobranie; przegrany: jeden świeży odczyt salda.
    expect(voucherify.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /v1/loyalties/camp_test/members",
      "POST /v1/loyalties/members/CARD-ola%40example.com/balance",
      "POST /v1/loyalties/members/CARD-ola%40example.com/balance",
      "GET /v1/loyalties/members/CARD-ola%40example.com",
    ]);
  });

  it("ktoś wydał punkty poza nami między odczytem a pobraniem (druga instancja, panel): punkty wracają, 409, brak sesji", async () => {
    class RacingProvider extends CountingLoyaltyProvider {
      override async getBalance(memberId: string, priority?: LoyaltyPriority) {
        const value = await super.getBalance(memberId, priority);
        // Zaraz po naszym świeżym odczycie inna instancja pobiera 600 punktów.
        this.panelAdjust(memberId, -600);
        return value;
      }
    }
    const provider = new RacingProvider({ allowNegative: true });
    provider.seedCard("ewa@example.com", 1000);
    ctx = await createTestContext({ loyaltyProvider: provider });
    seedAccount(ctx, "ewa@example.com", "ewa@example.com");
    const reservationId = await reserve("ewa@example.com", "5-1");

    const response = await checkout(reservationId, 1000);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "INSUFFICIENT_POINTS" });
    // Nasze pobranie zeszło do −600 i od razu wróciło: zostaje 1000 − 600 (cudze pobranie).
    expect(await provider.getBalance("ewa@example.com")).toBe(400);
    expect(provider.calls.filter((call) => call.op === "adjustPoints").map((call) => call.delta)).toEqual([-1000, 1000]);
    expect(ctx.payments.sessions).toHaveLength(0);
    expect(await status(reservationId)).toMatchObject({ pointsUsed: 0 });
  });
});

/** Wyszukiwanie kart z panelu jest domyślnie wyłączone (oszczędza limit 100/h). */
const LOOKUP = { loyalty: { lookupUnknownCards: true } };

describe("III.A2 — Voucherify jako źródło prawdy (karta z panelu, świeżość salda)", () => {
  it("karta założona w panelu z 3000 pkt: GET pokazuje 3000, checkout 2000 → 200, bez bonusu", async () => {
    const provider = new CountingLoyaltyProvider();
    provider.seedCard("kasa@example.com", 3000);
    ctx = await createTestContext({ loyaltyProvider: provider, overrides: LOOKUP });

    expect(await balance("kasa@example.com")).toBe(3000);
    expect(accountRow(ctx, "kasa@example.com")).toMatchObject({ member_id: "kasa@example.com", welcome_pending: 0 });
    expect(provider.calls.map((call) => call.op)).toEqual(["findMember"]);

    const reservationId = await reserve("kasa@example.com", "5-1");
    const response = await checkout(reservationId, 2000);
    expect(response.statusCode, response.body).toBe(200);
    expect(ctx.payments.sessions.at(-1)!.input.amount).toBe(6900);
    expect(await provider.getBalance("kasa@example.com")).toBe(1000);
    expect(provider.calls.filter((call) => call.op === "adjustPoints").map((call) => call.reason)).toEqual(["checkout"]);
  });

  it("karta z panelu bez wcześniejszego GET: checkout ponad bonus szuka karty i używa jej salda", async () => {
    const provider = new CountingLoyaltyProvider();
    provider.seedCard("kasa@example.com", 3000);
    ctx = await createTestContext({ loyaltyProvider: provider, overrides: LOOKUP });
    const reservationId = await reserve("kasa@example.com", "5-1");

    expect((await checkout(reservationId, 2000)).statusCode).toBe(200);
    expect(provider.calls.map((call) => call.op)).toEqual(["findMember", "adjustPoints"]);
    expect(await provider.getBalance("kasa@example.com")).toBe(1000);
  });

  it("karta z panelu z 200 pkt (bez GET): checkout 1000 → 409 bez żadnego zapisu, checkout 200 → sesja 8700", async () => {
    const provider = new CountingLoyaltyProvider();
    provider.seedCard("kasa@example.com", 200);
    ctx = await createTestContext({ loyaltyProvider: provider, overrides: LOOKUP });
    const reservationId = await reserve("kasa@example.com", "5-1");

    const refused = await checkout(reservationId, 1000);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "INSUFFICIENT_POINTS" });
    expect(provider.count("adjustPoints")).toBe(0);
    expect(await provider.getBalance("kasa@example.com")).toBe(200);

    expect((await checkout(reservationId, 200)).statusCode).toBe(200);
    expect(ctx.payments.sessions.at(-1)!.input.amount).toBe(8700);
    expect(await provider.getBalance("kasa@example.com")).toBe(0);
  });

  it("nowy e-mail bez karty: checkout ponad bonus → 409 bez zakładania karty (brak karty pamiętany 10 s)", async () => {
    const provider = new CountingLoyaltyProvider();
    ctx = await createTestContext({ loyaltyProvider: provider, overrides: LOOKUP });
    const reservationId = await reserve("nowy@example.com", "5-1");

    expect(await balance("nowy@example.com")).toBe(1000);
    expect((await checkout(reservationId, 2000)).statusCode).toBe(409);
    // Wynik wyszukania z GET wystarczył — checkout nie pytał drugi raz.
    expect(provider.calls.map((call) => call.op)).toEqual(["findMember"]);
    expect(accountRow(ctx, "nowy@example.com")).toBeUndefined();
  });

  it("karta założona w panelu po odczycie „brak karty” jest widoczna najpóźniej po 10 s", async () => {
    const provider = new CountingLoyaltyProvider();
    ctx = await createTestContext({ loyaltyProvider: provider, overrides: LOOKUP });

    expect(await balance("e2@example.com")).toBe(1000);
    provider.seedCard("e2@example.com", 3000);
    ctx.advance(9_000);
    expect(await balance("e2@example.com")).toBe(1000);
    ctx.advance(1_000);
    expect(await balance("e2@example.com")).toBe(3000);
    expect(provider.count("findMember")).toBe(2);
  });

  it("korekta +500 w panelu jest widoczna najpóźniej po 10 s (domyślny cache salda)", async () => {
    const provider = new CountingLoyaltyProvider();
    provider.seedCard("anna@example.com", 1790);
    ctx = await createTestContext({ loyaltyProvider: provider, overrides: LOOKUP });
    expect(await balance("anna@example.com")).toBe(1790);

    provider.panelAdjust("anna@example.com", 500);
    ctx.advance(9_999);
    expect(await balance("anna@example.com")).toBe(1790);
    ctx.advance(1);
    expect(await balance("anna@example.com")).toBe(2290);
  });

  it("karta z panelu bez historii (0 pkt): GET pokazuje bonus 1000, pierwszy zapis go przyznaje raz", async () => {
    const provider = new CountingLoyaltyProvider();
    provider.seedCard("pusta@example.com", 0);
    ctx = await createTestContext({ loyaltyProvider: provider, overrides: LOOKUP });

    expect(await balance("pusta@example.com")).toBe(1000);
    expect(accountRow(ctx, "pusta@example.com")).toMatchObject({ welcome_pending: 1 });
    const reservationId = await reserve("pusta@example.com", "5-1");
    expect((await checkout(reservationId, 1000)).statusCode).toBe(200);
    expect(provider.calls.filter((call) => call.op === "adjustPoints").map((call) => call.delta)).toEqual([1000, -1000]);
    expect(provider.count("createMember")).toBe(0);
  });

  it("przez HTTP (prawdziwy klient Voucherify): karta z panelu z 3000 → GET 3000 jednym wywołaniem, checkout 2000 → 200", async () => {
    const voucherify = stubVoucherify();
    voucherify.balances.set("CARD-kasa@example.com", 3000);
    ctx = await createTestContext({ overrides: { loyalty: voucherifyConfig({ lookupUnknownCards: true }) } });

    expect(await balance("kasa@example.com")).toBe(3000);
    expect(voucherify.calls).toEqual([{ method: "GET", path: "/v1/loyalties/camp_test/members" }]);
    const reservationId = await reserve("kasa@example.com", "5-1");
    expect((await checkout(reservationId, 2000)).statusCode).toBe(200);
    expect(voucherify.balances.get("CARD-kasa@example.com")).toBe(1000);
  });

  it("wyszukanie karty przy wyczerpanym budżecie odczytów albo awarii: 1000 jak dla nowego klienta, bez 503", async () => {
    const voucherify = stubVoucherify();
    voucherify.state.down = true;
    ctx = await createTestContext({ overrides: { loyalty: voucherifyConfig({ lookupUnknownCards: true }) } });
    const response = await loyalty("ktos@example.com");
    expect(response.statusCode).toBe(200);
    expect(response.json<LoyaltyResponse>().points).toBe(1000);
    // Awaria nie jest zapamiętana jako „brak karty”: po przywróceniu pytamy znowu.
    voucherify.state.down = false;
    voucherify.balances.set("CARD-ktos@example.com", 2500);
    expect(await balance("ktos@example.com")).toBe(2500);
  });
});

describe("limit checkoutów z punktami per IP i per e-mail (budżet Voucherify)", () => {
  const limits = {
    rateLimit: {
      enabled: true,
      global: { capacity: 1_000, refillPerSecond: 100 },
      reservation: { capacity: 1_000, refillPerSecond: 100 },
      purchase: { capacity: 1_000, refillPerSecond: 100 },
      loyalty: { capacity: 1_000, refillPerSecond: 100 },
    },
  };

  it("jedno IP: 12 checkoutów z punktami przechodzi (test wyścigu: 5 e-maili × 2), 13. → 429 z Retry-After; inne IP kupuje", async () => {
    const provider = new CountingLoyaltyProvider();
    ctx = await createTestContext({
      loyaltyProvider: provider,
      overrides: { rateLimit: { ...limits.rateLimit, pointsCheckoutIp: { capacity: 12, refillPerSecond: 6 / 3600 } } },
    });

    for (let index = 0; index < 12; index += 1) {
      const reservationId = await reserve(`klient${index}@example.com`, SEATS[index]!);
      expect((await checkout(reservationId, 100)).statusCode).toBe(200);
    }
    const reservationId = await reserve("klient12@example.com", SEATS[12]!);
    const calls = provider.calls.length;
    const limited = await checkout(reservationId, 100);
    expect(limited.statusCode).toBe(429);
    // 6 żetonów na godzinę → następny za 10 min.
    expect(limited.headers["retry-after"]).toBe("600");
    expect(limited.json()).toEqual({ error: "RATE_LIMITED", message: expect.any(String), retryAfter: 600 });
    expect(provider.calls).toHaveLength(calls);

    // Karta działa dalej (limit dotyczy tylko punktów), a inne IP kupuje z punktami.
    expect((await checkout(reservationId)).statusCode).toBe(200);
    const other = await reserve("inny@example.com", SEATS[13]!, "10.0.0.2");
    expect((await checkout(other, 1000, "10.0.0.2")).statusCode).toBe(200);

    ctx.advance(600_000);
    expect((await checkout(reservationId, 100)).statusCode).toBe(200);
  });

  it("nie zużywają żetonu: walidacja, limit połowy ceny, wygasła rezerwacja, powtórka tej samej sesji; 503 oddaje żeton", async () => {
    const provider = new CountingLoyaltyProvider();
    ctx = await createTestContext({
      loyaltyProvider: provider,
      overrides: { ...limits, rateLimit: { ...limits.rateLimit, pointsCheckoutIp: { capacity: 1, refillPerSecond: 0 } } },
    });
    const reservationId = await reserve("anna@example.com", "5-1");

    expect((await checkout(reservationId, -5)).statusCode).toBe(400);
    expect((await checkout(reservationId, 4451)).statusCode).toBe(409);
    // Stripe leży: 503, punkty wróciły, żeton też.
    ctx.payments.failWith = stripeDown();
    expect((await checkout(reservationId, 1000)).statusCode).toBe(503);
    ctx.payments.failWith = null;

    const key = newIdempotencyKey();
    expect((await checkout(reservationId, 1000, "10.0.0.1", key)).statusCode).toBe(200);
    // Powtórki (ten sam i inny klucz) to ta sama sesja — bez Voucherify i bez żetonu.
    expect((await checkout(reservationId, 1000, "10.0.0.1", key)).statusCode).toBe(200);
    expect((await checkout(reservationId, 1000)).statusCode).toBe(200);
    // Zmiana punktów to nowe pobranie — tu limit już działa.
    expect((await checkout(reservationId, 500)).statusCode).toBe(429);
  });

  it("jeden e-mail z wielu IP: 6 checkoutów z punktami, potem 429", async () => {
    const provider = new CountingLoyaltyProvider();
    ctx = await createTestContext({ loyaltyProvider: provider, overrides: limits });
    provider.seedCard("anna@example.com", 100_000);
    const reservations: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      reservations.push(await reserve("anna@example.com", SEATS[index]!, `10.0.1.${index}`));
    }
    for (let index = 0; index < 6; index += 1) {
      expect((await checkout(reservations[index]!, 100, `10.0.1.${index}`)).statusCode).toBe(200);
    }
    expect((await checkout(reservations[6]!, 100, "10.0.1.6")).statusCode).toBe(429);
  });
});

describe("koszt wywołań Voucherify na zakup (CONTRACT.md §11.6)", () => {
  it("nowy klient przez UI (saldo → checkout 1000 → zapłata → naliczenie): 1 odczyt + 3 checkout + 1 krytyczne", async () => {
    const provider = new CountingLoyaltyProvider();
    ctx = await createTestContext({ loyaltyProvider: provider });
    expect(await balance("nowy@example.com")).toBe(1000);
    const reservationId = await reserve("nowy@example.com", "5-1");
    expect((await checkout(reservationId, 1000)).statusCode).toBe(200);
    await pay(reservationId);
    expect(await ctx.services.worker.runOnce()).toBe(true);

    expect(provider.calls.map((call) => `${call.op}:${call.priority}`)).toEqual([
      "createMember:checkout",
      "adjustPoints:checkout",
      "adjustPoints:checkout",
      "adjustPoints:critical",
    ]);
    expect(await balance("nowy@example.com")).toBe(790);
  });

  it("stały klient (karta jest): świeży odczyt + pobranie + naliczenie = 3; GET w ciągu 10 s z cache", async () => {
    const provider = new CountingLoyaltyProvider();
    provider.seedCard("stary@example.com", 5000);
    ctx = await createTestContext({ loyaltyProvider: provider });
    seedAccount(ctx, "stary@example.com", "stary@example.com");
    expect(await balance("stary@example.com")).toBe(5000);
    provider.calls = [];

    const reservationId = await reserve("stary@example.com", "5-1");
    expect((await checkout(reservationId, 1000)).statusCode).toBe(200);
    await pay(reservationId);
    expect(await ctx.services.worker.runOnce()).toBe(true);
    expect(await balance("stary@example.com")).toBe(4790);
    expect(provider.calls.map((call) => `${call.op}:${call.priority}`)).toEqual([
      "getBalance:checkout",
      "adjustPoints:checkout",
      "adjustPoints:critical",
    ]);
  });
});
