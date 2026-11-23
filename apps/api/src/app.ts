import { timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { BookingService } from "./booking";
import { EventCatalog } from "./catalog";
import { CheckoutService } from "./checkout";
import {
  type AppConfig,
  type DeepPartial,
  loadConfig,
  mergeConfig,
} from "./config";
import { type Db, openDatabase } from "./db";
import type { ApiError } from "@pas/shared";
import { BusyError, HttpError, OverloadedError, RateLimitedError, UnauthorizedError } from "./errors";
import { GuardState, addLease, releaseLeases } from "./guards";
import { JobQueue } from "./jobs";
import {
  LoyaltyService,
  MemoryLoyaltyProvider,
  VoucherifyLoyaltyProvider,
  type LoyaltyProvider,
} from "./loyalty";
import { HttpMailer, MailAdmin, ResendMailer, type Mailer } from "./mail";
import { isTestSecretKey, type PaymentGateway, StripeGateway } from "./payments";
import { Bulkhead, CallBudget, CircuitBreaker, TokenBucket } from "./resilience";
import { registerEventRoutes, type Guard } from "./routes/events";
import { registerOpsRoutes } from "./routes/ops";
import { type PointsChargeFactory, registerReservationRoutes } from "./routes/reservations";
import { PointsReleaseSweeper } from "./sweeper";
import { registerWebhookRoutes } from "./routes/webhooks";
import { TicketMailWorker } from "./worker";

export type Clock = () => number;

export interface BuildAppOptions {
  config?: DeepPartial<AppConfig>;
  db?: Db;
  clock?: Clock;
  mailer?: Mailer;
  mailAdmin?: MailAdmin;
  /** Atrapa Stripe'a w testach. Bez niej bramka powstaje z kluczy w konfiguracji. */
  paymentGateway?: PaymentGateway | null;
  /** Atrapa Voucherify w testach (np. wymuszony błąd 503). */
  loyaltyProvider?: LoyaltyProvider;
  startWorker?: boolean;
  logger?: boolean;
}

export interface AppServices {
  config: AppConfig;
  db: Db;
  ownsDb: boolean;
  catalog: EventCatalog;
  jobs: JobQueue;
  bookings: BookingService;
  loyalty: LoyaltyService;
  /** Budżet wywołań Voucherify (Sandbox: 100/h) — wspólny dla całego procesu. */
  loyaltyBudget: CallBudget;
  breaker: CircuitBreaker;
  paymentBreaker: CircuitBreaker;
  checkout: CheckoutService;
  worker: TicketMailWorker;
  /** Zwrot punktów porzuconych sesji (III.B4). */
  sweeper: PointsReleaseSweeper;
  guards: GuardState;
  mailAdmin: MailAdmin;
  startedAt: number;
}

export interface BuiltApp {
  app: FastifyInstance;
  services: AppServices;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<BuiltApp> {
  const config = mergeConfig(loadConfig(), options.config);
  const clock = options.clock ?? (() => Date.now());
  const ownsDb = !options.db;
  const db = options.db ?? openDatabase(config.databasePath);

  const catalog = new EventCatalog();
  const jobs = new JobQueue(db, clock);
  const bookings = new BookingService(db, catalog, jobs, config.ttlMs, clock);
  const breaker = new CircuitBreaker({
    failureThreshold: config.mail.breakerFailureThreshold,
    resetTimeoutMs: config.mail.breakerResetMs,
    clock,
  });
  const mailer = options.mailer ?? createMailer(config);
  const mailAdmin =
    options.mailAdmin ?? new MailAdmin(config.mail.controlUrl, Math.min(config.mail.timeoutMs, 500));

  // Voucherify to trzecia zależność zewnętrzna (Etap III): własny bezpiecznik.
  // Bez kompletu kluczy Sandboxa działa fallback pamięciowy (dev/test).
  const loyaltyBreaker = new CircuitBreaker({
    failureThreshold: config.loyalty.breakerFailureThreshold,
    resetTimeoutMs: config.loyalty.breakerResetMs,
    clock,
  });
  // Sandbox Voucherify przyjmuje najwyżej 100 wywołań na godzinę: budżet z priorytetami
  // (odczyt < checkout < zwrot/naliczenie) pilnuje, żeby odczyty nie zjadły zakupów.
  const loyaltyBudget = new CallBudget({
    limit: config.loyalty.hourlyBudget,
    windowMs: 60 * 60_000,
    reserveCritical: config.loyalty.reserveCritical,
    reserveCheckout: config.loyalty.reserveCheckout,
    clock,
  });
  const loyalty = new LoyaltyService(
    db,
    options.loyaltyProvider ?? createLoyaltyProvider(config, loyaltyBreaker, loyaltyBudget, clock),
    config.loyalty.welcomePoints,
    clock,
    {
      cacheTtlMs: config.loyalty.balanceCacheTtlMs,
      staleTtlMs: config.loyalty.balanceStaleTtlMs,
      noCardTtlMs: config.loyalty.noCardCacheTtlMs,
      lookupUnknownCards: config.loyalty.lookupUnknownCards,
    },
  );

  // Stripe to druga zależność zewnętrzna (E04): własny bezpiecznik, niezależny od poczty.
  const paymentBreaker = new CircuitBreaker({
    failureThreshold: config.payments.breakerFailureThreshold,
    resetTimeoutMs: config.payments.breakerResetMs,
    clock,
  });
  const paymentGateway =
    options.paymentGateway !== undefined ? options.paymentGateway : createPaymentGateway(config);
  const checkout = new CheckoutService({
    db,
    bookings,
    catalog,
    gateway: paymentGateway,
    breaker: paymentBreaker,
    loyalty,
    jobs,
    publicUrl: config.payments.publicUrl,
    clock,
  });

  const readPool = new Bulkhead({
    concurrency: config.bulkhead.read.concurrency,
    maxQueue: config.bulkhead.read.queue,
    waitTimeoutMs: config.bulkhead.waitTimeoutMs,
  });
  const writePool = new Bulkhead({
    concurrency: config.bulkhead.write.concurrency,
    maxQueue: config.bulkhead.write.queue,
    waitTimeoutMs: config.bulkhead.waitTimeoutMs,
  });
  const guards = new GuardState(config.overload.maxInFlight, readPool, writePool);

  const worker = new TicketMailWorker({
    queue: jobs,
    bookings,
    catalog,
    mailer,
    breaker,
    loyalty,
    config,
    clock,
  });

  // III.B4: punkty porzuconych sesji wracają kilka sekund po wygaśnięciu rezerwacji.
  const sweeper = new PointsReleaseSweeper({
    checkout,
    intervalMs: config.pointsSweep.intervalMs,
    batchSize: config.pointsSweep.batchSize,
    clock,
    onError: (error) => app.log.error({ err: error }, "Zwrot punktów porzuconych sesji nie powiódł się"),
  });

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 32 * 1024,
    // Nagłówki muszą dojść w tym czasie (inaczej 408), a połączenie, przez które nic
    // nie płynie dłużej niż ten czas, jest zamykane — tak kończy się klient, który
    // wysłał nagłówki i „zapomniał” o body.
    requestTimeout: config.overload.requestTimeoutMs,
    connectionTimeout: config.overload.requestTimeoutMs,
    // Node sprawdza requestTimeout cyklicznie, domyślnie co 30 s.
    http: {
      connectionsCheckingInterval: Math.max(
        50,
        Math.min(1_000, Math.round(config.overload.requestTimeoutMs / 4)),
      ),
    },
    disableRequestLogging: true,
    trustProxy: config.trustProxy,
  });

  // Handlery błędów muszą być ustawione przed pierwszym `await app.register(...)` —
  // trasy zarejestrowane wcześniej zapamiętują domyślny handler Fastify
  // (inna koperta błędu i 429 bez Retry-After).
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      if (error.cause !== undefined) {
        request.log.warn({ err: error.cause, code: error.code }, error.message);
      }
      if (error.retryAfter !== undefined) {
        reply.header("retry-after", String(error.retryAfter));
      }
      // Komunikat HttpError jest zawsze tekstem dla klienta (przyczyna techniczna siedzi w `cause`).
      reply.code(error.statusCode).send(errorBody(error.code, error.message, error.retryAfter));
      return;
    }

    const statusCode = (error as { statusCode?: number }).statusCode;
    // Błędy Fastify z zakresu 4xx (zły JSON, zły Content-Type, za duże body) to odmowa, nie awaria.
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      // Treść błędu Fastify bywa techniczna — klient dostaje stały komunikat.
      reply.code(statusCode).send(errorBody("VALIDATION_ERROR", GENERIC_MESSAGES.VALIDATION_ERROR));
      return;
    }

    request.log.error({ err: error }, "Nieobsłużony błąd API");
    reply.code(500).send(errorBody("INTERNAL_ERROR", GENERIC_MESSAGES.INTERNAL_ERROR));
  });

  app.setNotFoundHandler((request, reply) => {
    // Fallback SPA: trasy Reacta (/events/..., /lab) dostają index.html.
    // /api/* i brakujące pliki (ścieżka z rozszerzeniem) zostają przy JSON 404.
    if (config.webDistPath && isSpaRoute(request)) {
      reply.header("cache-control", "no-cache");
      return reply.type("text/html").sendFile("index.html");
    }
    return reply.code(404).send(errorBody("NOT_FOUND", GENERIC_MESSAGES.NOT_FOUND));
  });

  // Zakup nie ma body, ale klienci często i tak wysyłają `Content-Type: application/json`.
  // Puste body traktujemy jak brak body zamiast odpowiadać 400.
  const defaultJsonParser = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") {
      done(null, undefined);
      return;
    }
    defaultJsonParser(request, text, done);
  });

  await app.register(cors, { origin: true, methods: ["GET", "POST", "OPTIONS"] });

  const globalLimiter = new TokenBucket({
    capacity: config.rateLimit.global.capacity,
    refillPerSecond: config.rateLimit.global.refillPerSecond,
    clock,
  });
  const reservationLimiter = new TokenBucket({
    capacity: config.rateLimit.reservation.capacity,
    refillPerSecond: config.rateLimit.reservation.refillPerSecond,
    clock,
  });
  const purchaseLimiter = new TokenBucket({
    capacity: config.rateLimit.purchase.capacity,
    refillPerSecond: config.rateLimit.purchase.refillPerSecond,
    clock,
  });
  const loyaltyLimiter = new TokenBucket({
    capacity: config.rateLimit.loyalty.capacity,
    refillPerSecond: config.rateLimit.loyalty.refillPerSecond,
    clock,
  });
  const pointsIpLimiter = new TokenBucket({
    capacity: config.rateLimit.pointsCheckoutIp.capacity,
    refillPerSecond: config.rateLimit.pointsCheckoutIp.refillPerSecond,
    clock,
  });
  const pointsEmailLimiter = new TokenBucket({
    capacity: config.rateLimit.pointsCheckoutEmail.capacity,
    refillPerSecond: config.rateLimit.pointsCheckoutEmail.refillPerSecond,
    clock,
  });

  const isGuardedApi = (request: FastifyRequest): boolean => {
    const path = requestPath(request);
    if (!path.startsWith("/api") || path.startsWith("/api/health")) return false;
    return request.method !== "OPTIONS";
  };

  // Globalny limit per IP działa od razu, zanim serwer zacznie czytać body.
  app.addHook("onRequest", async (request, reply) => {
    if (!isGuardedApi(request) || !config.rateLimit.enabled) return;
    const result = globalLimiter.consume(request.ip);
    setRateLimitHeaders(reply, config.rateLimit.global.capacity, result);
    if (!result.allowed) {
      guards.rateLimited += 1;
      throw new RateLimitedError(result.retryAfterSeconds);
    }
  });

  // Load shedding liczy dopiero requesty z odebranym body. Klient, który wysyła
  // nagłówki i nie kończy body, nie zajmuje miejsca innym — i po requestTimeout
  // Fastify sam go rozłącza.
  app.addHook("preHandler", async (request, reply) => {
    if (!isGuardedApi(request)) return;

    // Load shedding: szybkie 503, zanim kolejka requestów zje cały serwer.
    if (guards.inFlight >= config.overload.maxInFlight) {
      guards.loadShedRejected += 1;
      reply.header("retry-after", String(config.overload.retryAfterSeconds));
      const overloaded = new OverloadedError(config.overload.retryAfterSeconds);
      return reply
        .code(503)
        .send(errorBody(overloaded.code, overloaded.message, overloaded.retryAfter));
    }

    guards.inFlight += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      guards.inFlight = Math.max(0, guards.inFlight - 1);
    };
    addLease(request, release);
  });

  const readGuards: Guard[] = [createBulkheadGuard(readPool)];
  // Rezerwacje odrzucone walidacją (400/413/415) oddają żeton: tester z jednego IP
  // po serii złych requestów (B3) nie zużywa limitu potrzebnego na prawdziwe rezerwacje.
  // 404 i 409 żetonu nie oddają — inaczej zalew nieistniejących albo zajętych miejsc
  // (B5) nigdy nie dostałby 429.
  const reservationGuards: Guard[] = [
    createRateLimitGuard(reservationLimiter, config.rateLimit.reservation.capacity, config, guards, {
      refundStatuses: REFUNDED_STATUSES,
    }),
    createBulkheadGuard(writePool),
  ];
  const purchaseGuards: Guard[] = [
    createRateLimitGuard(purchaseLimiter, config.rateLimit.purchase.capacity, config, guards),
    createBulkheadGuard(writePool),
  ];

  // Saldo punktów: osobny limit per IP przed pulą odczytów. Zły e-mail (400) oddaje
  // żeton — nie dotknął Voucherify — ale zalew poprawnych adresów dostaje 429.
  const loyaltyGuards: Guard[] = [
    createRateLimitGuard(loyaltyLimiter, config.rateLimit.loyalty.capacity, config, guards, {
      refundStatuses: REFUNDED_STATUSES,
    }),
    createBulkheadGuard(readPool),
  ];

  // Checkout z punktami kosztuje 1–4 wywołania Voucherify (limit 100/h na cały sklep):
  // osobny limit per IP i per e-mail, pobierany dopiero, gdy żądanie dochodzi do Voucherify.
  const pointsCharge: PointsChargeFactory = (request) => {
    const charged: Array<{ limiter: TokenBucket; key: string }> = [];
    return {
      charge: (email: string) => {
        if (!config.rateLimit.enabled) return;
        for (const [limiter, key] of [
          [pointsIpLimiter, `ip:${request.ip}`],
          [pointsEmailLimiter, `email:${email}`],
        ] as const) {
          const result = limiter.consume(key);
          if (!result.allowed) {
            // Drugi limit odmówił — pierwszy żeton wraca, żądanie nic nie zużyło.
            for (const item of charged.splice(0)) item.limiter.refund(item.key);
            guards.rateLimited += 1;
            throw new RateLimitedError(result.retryAfterSeconds);
          }
          charged.push({ limiter, key });
        }
      },
      refund: () => {
        for (const item of charged.splice(0)) item.limiter.refund(item.key);
      },
    };
  };

  registerEventRoutes(app, { catalog, bookings, readGuards });
  registerReservationRoutes(app, {
    bookings,
    checkout,
    loyalty,
    readGuards,
    loyaltyGuards,
    reservationGuards,
    purchaseGuards,
    pointsCharge,
  });
  await registerWebhookRoutes(app, { checkout });

  if (config.opsEnabled) {
    if (config.opsToken) {
      const opsToken = config.opsToken;
      app.addHook("onRequest", async (request) => {
        // Wzorzec trasy, nie surowy URL: /api/%6Fps/... trafia w tę samą trasę co /api/ops/...
        if (!request.routeOptions.url?.startsWith("/api/ops")) return;
        if (request.method === "OPTIONS") return;
        if (!hasOpsToken(request, opsToken)) throw new UnauthorizedError();
      });
    }

    registerOpsRoutes(app, {
      config,
      clock,
      startedAt: clock(),
      bookings,
      queue: jobs,
      worker,
      breaker,
      guards,
      mailAdmin,
      readGuards,
      loyalty: () => ({
        provider: loyalty.providerName,
        budget: loyaltyBudget.snapshot(),
        cache: loyalty.snapshot(),
      }),
    });
  }

  // Healthcheck pokazuje też efektywny TTL — tak sprawdzisz tryb testowy bez panelu ops.
  app.get("/api/health", async () => ({
    ok: true,
    now: new Date(clock()).toISOString(),
    reservationTtlSeconds: Math.round(config.ttlMs / 1000),
  }));

  // Jeden proces i jeden adres na produkcji: API serwuje też zbudowany frontend.
  if (config.webDistPath) {
    await app.register(fastifyStatic, {
      root: config.webDistPath,
      // Pliki są znane w chwili startu, więc nieznane /api/* nie wpadają w handler plików.
      wildcard: false,
      // Cache-Control ustawiamy sami w setHeaders.
      cacheControl: false,
      setHeaders: (res, filePath) => {
        // Pliki z hashem w nazwie (assets/) można trzymać długo; index.html zawsze świeży.
        const immutable = /[\\/]assets[\\/]/.test(filePath);
        res.setHeader("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
      },
    });
  }


  app.addHook("onResponse", async (request) => {
    releaseLeases(request);
  });

  app.addHook("onRequestAbort", async (request) => {
    releaseLeases(request);
  });

  app.addHook("onClose", async () => {
    await sweeper.stop();
    await worker.stop();
    if (ownsDb) db.close();
  });

  await app.ready();

  if (options.startWorker && config.worker.enabled) {
    worker.start();
  }
  if (options.startWorker && config.pointsSweep.enabled && checkout.enabled) {
    sweeper.start();
  }

  return {
    app,
    services: {
      config,
      db,
      ownsDb,
      catalog,
      jobs,
      bookings,
      loyalty,
      loyaltyBudget,
      breaker,
      paymentBreaker,
      checkout,
      worker,
      sweeper,
      guards,
      mailAdmin,
      startedAt: clock(),
    },
  };
}

/** Resend, gdy jest klucz; inaczej lokalny mock HTTP (Etap I). */
function createMailer(config: AppConfig): Mailer {
  if (config.resend.apiKey) {
    return new ResendMailer({
      apiKey: config.resend.apiKey,
      from: config.resend.from,
      apiUrl: config.resend.apiUrl,
      timeoutMs: config.resend.timeoutMs,
    });
  }
  return new HttpMailer(config.mail.providerUrl, config.mail.timeoutMs);
}

function createLoyaltyProvider(
  config: AppConfig,
  breaker: CircuitBreaker,
  budget: CallBudget,
  clock: Clock,
): VoucherifyLoyaltyProvider | MemoryLoyaltyProvider {
  if (config.loyalty.provider === "voucherify") {
    return new VoucherifyLoyaltyProvider({
      appId: config.loyalty.appId ?? "",
      appToken: config.loyalty.appToken ?? "",
      campaignId: config.loyalty.campaignId ?? "",
      apiUrl: config.loyalty.apiUrl,
      timeoutMs: config.loyalty.timeoutMs,
      maxRetries: config.loyalty.maxRetries,
      breaker,
      budget,
      clock,
    });
  }
  return new MemoryLoyaltyProvider();
}

/** Prawdziwy Stripe tylko z kluczem testowym i sekretem webhooka; inaczej płatności są wyłączone. */
function createPaymentGateway(config: AppConfig): PaymentGateway | null {
  const { stripeSecretKey, stripeWebhookSecret } = config.payments;
  if (!stripeSecretKey || !stripeWebhookSecret || !isTestSecretKey(stripeSecretKey)) return null;
  return new StripeGateway({
    secretKey: stripeSecretKey,
    webhookSecret: stripeWebhookSecret,
    timeoutMs: config.payments.timeoutMs,
    maxNetworkRetries: config.payments.maxNetworkRetries,
  });
}

function createBulkheadGuard(pool: Bulkhead): Guard {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    let release: () => void;
    try {
      release = await pool.acquire();
    } catch {
      throw new BusyError(1);
    }
    addLease(request, release);
  };
}

/** Odmowy walidacji: request nie dotknął bazy, więc nie powinien zużywać limitu zapisów. */
const REFUNDED_STATUSES: ReadonlySet<number> = new Set([400, 413, 415]);

function createRateLimitGuard(
  limiter: TokenBucket,
  capacity: number,
  config: AppConfig,
  guards: GuardState,
  options: { refundStatuses?: ReadonlySet<number> } = {},
): Guard {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!config.rateLimit.enabled) return;
    const key = request.ip;
    const result = limiter.consume(key);
    setRateLimitHeaders(reply, capacity, result);
    if (!result.allowed) {
      guards.rateLimited += 1;
      throw new RateLimitedError(result.retryAfterSeconds);
    }
    const refundStatuses = options.refundStatuses;
    if (refundStatuses) {
      // Lease zwalnia się w onResponse, kiedy status odpowiedzi jest już znany.
      addLease(request, () => {
        if (refundStatuses.has(reply.statusCode)) limiter.refund(key);
      });
    }
  };
}

/** Token z `Authorization: Bearer …`; porównanie w stałym czasie. */
function hasOpsToken(request: FastifyRequest, expected: string): boolean {
  const header = request.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const given = Buffer.from(match[1]!.trim());
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/** Ścieżka po zdekodowaniu %xx — tak, jak widzi ją router (/%61pi to też /api). */
function requestPath(request: FastifyRequest): string {
  const raw = request.url.split("?")[0] ?? "/";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function isSpaRoute(request: FastifyRequest): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const path = requestPath(request);
  if (path === "/api" || path.startsWith("/api/")) return false;
  const lastSegment = path.slice(path.lastIndexOf("/") + 1);
  return !lastSegment.includes(".");
}

function setRateLimitHeaders(
  reply: FastifyReply,
  capacity: number,
  result: { remaining: number; retryAfterSeconds: number },
): void {
  reply.header("ratelimit-limit", String(capacity));
  reply.header("ratelimit-remaining", String(result.remaining));
  reply.header("ratelimit-reset", String(result.retryAfterSeconds));
}

/** Stałe komunikaty dla błędów spoza HttpError — nigdy nie ujawniają przyczyny. */
const GENERIC_MESSAGES = {
  VALIDATION_ERROR: "Nieprawidłowe dane wejściowe.",
  NOT_FOUND: "Nie znaleziono zasobu.",
  INTERNAL_ERROR: "Wystąpił błąd serwera. Spróbuj ponownie za chwilę.",
} as const;

/** Jedna koperta błędu dla całego API: kod dla programu, komunikat dla człowieka. */
function errorBody(code: string, message: string, retryAfter?: number): ApiError {
  return retryAfter === undefined ? { error: code, message } : { error: code, message, retryAfter };
}
