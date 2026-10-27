import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { configWarnings, loadConfig } from "../src/config";
import { createTestContext, reservationPayload, type TestContext } from "./helpers";

/** Komplet zmiennych płatności — bez nich konfiguracja słusznie ostrzega. */
const PAYMENTS_ENV = {
  STRIPE_SECRET_KEY: "sk_test_pas",
  STRIPE_WEBHOOK_SECRET: "whsec_pas",
  PUBLIC_URL: "https://kasa.example.com",
};

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

describe("konfiguracja wdrożenia", () => {
  it("lokalnie słucha na loopbacku i ma panel ops", () => {
    const config = loadConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.opsEnabled).toBe(true);
    expect(config.opsToken).toBeNull();
  });

  it("na produkcji słucha na 0.0.0.0, a panel ops jest wyłączony, chyba że jawnie włączony", () => {
    const production = loadConfig({ NODE_ENV: "production" });
    expect(production.host).toBe("0.0.0.0");
    expect(production.opsEnabled).toBe(false);

    const explicit = loadConfig({ NODE_ENV: "production", HOST: "10.0.0.5", OPS_ENABLED: "true" });
    expect(explicit.host).toBe("10.0.0.5");
    expect(explicit.opsEnabled).toBe(true);
  });

  it("TRUST_PROXY: liczba to hopy, true ufa wszystkim, 0/false wyłącza", () => {
    expect(loadConfig({}).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: "1" }).trustProxy).toBe(1);
    expect(loadConfig({ TRUST_PROXY: "2" }).trustProxy).toBe(2);
    expect(loadConfig({ TRUST_PROXY: "0" }).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: "false" }).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(loadConfig({ TRUST_PROXY: "10.0.0.0/8" }).trustProxy).toBe("10.0.0.0/8");
  });

  it("limit rezerwacji da się dostroić zmiennymi", () => {
    expect(loadConfig({}).rateLimit.reservation).toEqual({ capacity: 40, refillPerSecond: 4 });
    const tuned = loadConfig({
      RATE_LIMIT_RESERVATION_CAPACITY: "80",
      RATE_LIMIT_RESERVATION_REFILL_PER_SECOND: "3",
    });
    expect(tuned.rateLimit.reservation).toEqual({ capacity: 80, refillPerSecond: 3 });
  });

  it("ostrzega przy obu zmiennych TTL, TRUST_PROXY=true i otwartym ops na produkcji", () => {
    expect(configWarnings(loadConfig({ ...PAYMENTS_ENV, RESERVATION_TTL_MINUTES: "2" }))).toEqual([]);

    const conflict = loadConfig({ RESERVATION_TTL_SECONDS: "20", RESERVATION_TTL_MINUTES: "2" });
    expect(conflict.ttlMs).toBe(20_000);
    expect(conflict.ttlSource).toBe("RESERVATION_TTL_SECONDS");
    expect(configWarnings(conflict).join(" ")).toContain("RESERVATION_TTL_MINUTES");

    expect(configWarnings(loadConfig({ TRUST_PROXY: "true" })).join(" ")).toContain("TRUST_PROXY=1");
    expect(configWarnings(loadConfig({ ...PAYMENTS_ENV, TRUST_PROXY: "1" }))).toEqual([]);

    const openOps = loadConfig({ NODE_ENV: "production", OPS_ENABLED: "true" });
    expect(configWarnings(openOps).join(" ")).toContain("OPS_TOKEN");
    const tokenOps = loadConfig({
      ...PAYMENTS_ENV,
      NODE_ENV: "production",
      OPS_ENABLED: "true",
      OPS_TOKEN: "sekret",
      RESERVATION_TTL_MINUTES: "2",
    });
    expect(configWarnings(tokenOps)).toEqual([]);
  });

  it("ostrzega przy niepoprawnym TTL i przy produkcji na domyślnych 15 minutach", () => {
    const typo = configWarnings(loadConfig({ RESERVATION_TTL_MINUTES: "2min" })).join(" ");
    expect(typo).toContain("RESERVATION_TTL_MINUTES ma niepoprawną wartość");

    const prodDefault = configWarnings(loadConfig({ NODE_ENV: "production" })).join(" ");
    expect(prodDefault).toContain("domyślnym TTL 15 min");
    expect(
      configWarnings(loadConfig({ ...PAYMENTS_ENV, NODE_ENV: "production", RESERVATION_TTL_MINUTES: "2" })),
    ).toEqual([]);
  });

  it("ostrzega o wyłączonych płatnościach, kluczu live i PUBLIC_URL na localhost w produkcji", () => {
    expect(configWarnings(loadConfig({})).join(" ")).toContain("Płatności są wyłączone");

    const live = configWarnings(loadConfig({ ...PAYMENTS_ENV, STRIPE_SECRET_KEY: "sk_live_123" })).join(" ");
    expect(live).toContain("nie jest kluczem testowym");

    const localhost = configWarnings(
      loadConfig({ ...PAYMENTS_ENV, NODE_ENV: "production", RESERVATION_TTL_MINUTES: "2", PUBLIC_URL: "" }),
    ).join(" ");
    expect(localhost).toContain("PUBLIC_URL");
  });

  it("healthcheck pokazuje efektywny TTL", async () => {
    ctx = await createTestContext({ overrides: { ttlMs: 120_000 } });
    const response = await ctx.app.inject({ method: "GET", url: "/api/health" });
    expect(response.json()).toMatchObject({ ok: true, reservationTtlSeconds: 120 });
  });
});

describe("zakup z pustym body JSON", () => {
  it("Content-Type: application/json bez body nie daje 400 — dochodzi do sprawdzenia płatności", async () => {
    ctx = await createTestContext();
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/reservations",
      payload: reservationPayload(),
    });
    const { reservationId } = created.json<{ reservationId: string }>();

    const purchase = await ctx.app.inject({
      method: "POST",
      url: `/api/reservations/${reservationId}/purchase`,
      headers: { "content-type": "application/json" },
    });
    // Body jest poprawnie puste; odmowa wynika z braku płatności (Etap II), nie z parsera.
    expect(purchase.statusCode).toBe(402);
    expect(purchase.json()).toEqual({ error: "PAYMENT_REQUIRED" });

    // Zły JSON dalej jest odmową 400, a pusta rezerwacja — błędem walidacji.
    const broken = await ctx.app.inject({
      method: "POST",
      url: "/api/reservations",
      headers: { "content-type": "application/json" },
      payload: "{zly",
    });
    expect(broken.statusCode).toBe(400);
    const empty = await ctx.app.inject({
      method: "POST",
      url: "/api/reservations",
      headers: { "content-type": "application/json" },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toEqual({ error: "VALIDATION_ERROR" });
  });
});

describe("panel ops z OPS_TOKEN", () => {
  it("bez tokenu albo ze złym tokenem 401, z dobrym 200; kontrakt bez zmian", async () => {
    ctx = await createTestContext({ overrides: { opsToken: "tajny-token" } });

    const none = await ctx.app.inject({ method: "GET", url: "/api/ops/jobs" });
    expect(none.statusCode).toBe(401);
    expect(none.json()).toEqual({ error: "UNAUTHORIZED" });

    const wrong = await ctx.app.inject({
      method: "GET",
      url: "/api/ops/mail/messages",
      headers: { authorization: "Bearer zly-token" },
    });
    expect(wrong.statusCode).toBe(401);

    const ok = await ctx.app.inject({
      method: "GET",
      url: "/api/ops/jobs",
      headers: { authorization: "Bearer tajny-token" },
    });
    expect(ok.statusCode).toBe(200);

    // Zakodowana litera w ścieżce trafia w tę samą trasę, więc też wymaga tokenu.
    for (const url of ["/api/%6Fps/jobs", "/api/%6fps/status", "/%61pi/ops/jobs"]) {
      expect((await ctx.app.inject({ method: "GET", url })).statusCode).toBe(401);
    }

    // Token chroni tylko /api/ops; kontrakt i healthcheck działają bez niego.
    expect((await ctx.app.inject({ method: "GET", url: "/api/events" })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
  });
});

describe("serwowanie zbudowanego frontendu", () => {
  let webDir: string;

  beforeAll(() => {
    webDir = mkdtempSync(join(tmpdir(), "pas-web-"));
    mkdirSync(join(webDir, "assets"));
    writeFileSync(join(webDir, "index.html"), "<!doctype html><div id=root></div>");
    writeFileSync(join(webDir, "assets", "app-abc123.js"), "console.log('pas');");
  });

  afterAll(() => {
    rmSync(webDir, { recursive: true, force: true });
  });

  it("serwuje index.html, pliki i fallback SPA; /api/* dalej zwraca JSON 404", async () => {
    ctx = await createTestContext({ overrides: { webDistPath: webDir } });

    const root = await ctx.app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.headers["content-type"]).toContain("text/html");
    expect(root.body).toContain('id=root');

    const asset = await ctx.app.inject({ method: "GET", url: "/assets/app-abc123.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toContain("immutable");

    for (const url of ["/lab", "/events/ic-7310-2026-11-21/reserve/5-1?x=1", "/reservations/abc/ticket"]) {
      const spa = await ctx.app.inject({ method: "GET", url });
      expect(spa.statusCode, url).toBe(200);
      expect(spa.headers["content-type"]).toContain("text/html");
      expect(spa.body).toContain('id=root');
    }

    const missingAsset = await ctx.app.inject({ method: "GET", url: "/assets/nie-ma.js" });
    expect(missingAsset.statusCode).toBe(404);
    expect(missingAsset.json()).toEqual({ error: "NOT_FOUND" });

    for (const url of ["/api/nie-ma", "/api/events/nie-ma/costam", "/api"]) {
      const api = await ctx.app.inject({ method: "GET", url });
      expect(api.statusCode, url).toBe(404);
      expect(api.json()).toEqual({ error: "NOT_FOUND" });
    }

    const post = await ctx.app.inject({ method: "POST", url: "/lab" });
    expect(post.statusCode).toBe(404);

    const events = await ctx.app.inject({ method: "GET", url: "/api/events" });
    expect(events.statusCode).toBe(200);
    expect(Array.isArray(events.json())).toBe(true);
  });

  it("z frontendem błędy API mają tę samą kopertę, a 429 ma Retry-After", async () => {
    ctx = await createTestContext({
      overrides: {
        webDistPath: webDir,
        rateLimit: {
          enabled: true,
          global: { capacity: 1_000, refillPerSecond: 0 },
          reservation: { capacity: 1, refillPerSecond: 0 },
          purchase: { capacity: 10, refillPerSecond: 0 },
        },
      },
    });

    const missing = await ctx.app.inject({ method: "GET", url: "/api/events/nie-ma-takiego" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "EVENT_NOT_FOUND" });

    const payload = reservationPayload();
    expect((await ctx.app.inject({ method: "POST", url: "/api/reservations", payload })).statusCode).toBe(201);
    const limited = await ctx.app.inject({
      method: "POST",
      url: "/api/reservations",
      payload: reservationPayload({ seatId: "5-2" }),
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(limited.json()).toEqual({ error: "RATE_LIMITED", retryAfter: 60 });
  });

  it("bez zbudowanego frontendu nieznane ścieżki to JSON 404", async () => {
    ctx = await createTestContext();
    const response = await ctx.app.inject({ method: "GET", url: "/lab" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "NOT_FOUND" });
  });

  it("SERVE_WEB=false i katalog bez index.html wyłączają serwowanie", () => {
    expect(loadConfig({ SERVE_WEB: "false", WEB_DIST_PATH: webDir }).webDistPath).toBeNull();
    expect(loadConfig({ WEB_DIST_PATH: join(webDir, "assets") }).webDistPath).toBeNull();
    expect(loadConfig({ WEB_DIST_PATH: webDir }).webDistPath).toBe(webDir);
  });
});
