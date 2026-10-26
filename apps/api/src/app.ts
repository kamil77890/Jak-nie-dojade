import { timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { BookingService } from "./booking";
import { EventCatalog } from "./catalog";
import {
  type AppConfig,
  type DeepPartial,
  loadConfig,
  mergeConfig,
} from "./config";
import { type Db, openDatabase } from "./db";
import { BusyError, HttpError, RateLimitedError, UnauthorizedError } from "./errors";
import { GuardState, addLease, releaseLeases } from "./guards";
import { JobQueue } from "./jobs";
import { HttpMailer, MailAdmin, type Mailer } from "./mail";
import { Bulkhead, CircuitBreaker, TokenBucket } from "./resilience";
import { registerEventRoutes, type Guard } from "./routes/events";
import { registerOpsRoutes } from "./routes/ops";
import { registerReservationRoutes } from "./routes/reservations";
import { TicketMailWorker } from "./worker";

export type Clock = () => number;

export interface BuildAppOptions {
  config?: DeepPartial<AppConfig>;
  db?: Db;
  clock?: Clock;
  mailer?: Mailer;
  mailAdmin?: MailAdmin;
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
  breaker: CircuitBreaker;
  worker: TicketMailWorker;
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
  const mailer = options.mailer ?? new HttpMailer(config.mail.providerUrl, config.mail.timeoutMs);
  const mailAdmin =
    options.mailAdmin ?? new MailAdmin(config.mail.controlUrl, Math.min(config.mail.timeoutMs, 500));

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
    config,
    clock,
  });

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 32 * 1024,
    disableRequestLogging: true,
    trustProxy: config.trustProxy,
  });

  // Handlery błędów muszą być ustawione przed pierwszym `await app.register(...)` —
  // trasy zarejestrowane wcześniej zapamiętują domyślny handler Fastify
  // (inna koperta błędu i 429 bez Retry-After).
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      if (error.retryAfter !== undefined) {
        reply.header("retry-after", String(error.retryAfter));
      }
      const payload: { error: string; retryAfter?: number } = { error: error.code };
      if (error.retryAfter !== undefined) payload.retryAfter = error.retryAfter;
      reply.code(error.statusCode).send(payload);
      return;
    }

    const statusCode = (error as { statusCode?: number }).statusCode;
    // Błędy Fastify z zakresu 4xx (zły JSON, zły Content-Type, za duże body) to odmowa, nie awaria.
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      reply.code(statusCode).send({ error: "VALIDATION_ERROR" });
      return;
    }

    request.log.error({ err: error }, "Nieobsłużony błąd API");
    reply.code(500).send({ error: "INTERNAL_ERROR" });
  });

  app.setNotFoundHandler((request, reply) => {
    // Fallback SPA: trasy Reacta (/events/..., /lab) dostają index.html.
    // /api/* i brakujące pliki (ścieżka z rozszerzeniem) zostają przy JSON 404.
    if (config.webDistPath && isSpaRoute(request)) {
      reply.header("cache-control", "no-cache");
      return reply.type("text/html").sendFile("index.html");
    }
    return reply.code(404).send({ error: "NOT_FOUND" });
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

  app.addHook("onRequest", async (request, reply) => {
    const path = requestPath(request);
    if (!path.startsWith("/api") || path.startsWith("/api/health")) return;
    if (request.method === "OPTIONS") return;

    // Load shedding: szybkie 503, zanim kolejka requestów zje cały serwer.
    if (guards.inFlight >= config.overload.maxInFlight) {
      guards.loadShedRejected += 1;
      reply.header("retry-after", String(config.overload.retryAfterSeconds));
      return reply.code(503).send({
        error: "OVERLOADED",
        retryAfter: config.overload.retryAfterSeconds,
      });
    }

    guards.inFlight += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      guards.inFlight = Math.max(0, guards.inFlight - 1);
    };
    addLease(request, release);

    if (config.rateLimit.enabled) {
      const result = globalLimiter.consume(request.ip);
      setRateLimitHeaders(reply, config.rateLimit.global.capacity, result);
      if (!result.allowed) {
        guards.rateLimited += 1;
        throw new RateLimitedError(result.retryAfterSeconds);
      }
    }
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

  registerEventRoutes(app, { catalog, bookings, readGuards });
  registerReservationRoutes(app, { bookings, reservationGuards, purchaseGuards });

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
    await worker.stop();
    if (ownsDb) db.close();
  });

  await app.ready();

  if (options.startWorker && config.worker.enabled) {
    worker.start();
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
      breaker,
      worker,
      guards,
      mailAdmin,
      startedAt: clock(),
    },
  };
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
